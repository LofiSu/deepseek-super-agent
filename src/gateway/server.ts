import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { GatewayConfig, GatewayProvider } from './config.ts'
import { upstreamUrl } from './config.ts'
import { GatewayRouter } from './router.ts'
import { PluginHost, type JsonObject, type RouteSeat } from './plugins.ts'
import { maskingPlugin, Masker, deepUnmask } from './mask.ts'
import { strategyPlugin } from './builtin-plugins.ts'
import { GatewayLimits } from './limits.ts'
import { UsageLedger, type UsageRow } from './usage.ts'
import { Affinity } from './affinity.ts'

interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export interface GatewayMetricsSnapshot {
  requests: number
  errors: number
  byProvider: Record<string, { requests: number; errors: number; latencyMs: number; tokens: number }>
}

/** In-memory counters for the gateway (per provider: requests/errors/latency/tokens). */
class GatewayMetrics {
  private requests = 0
  private errors = 0
  private readonly byProvider: GatewayMetricsSnapshot['byProvider'] = {}

  record(providerId: string, latencyMs: number, ok: boolean, usage?: Usage): void {
    this.requests += 1
    if (!ok) this.errors += 1
    const row = this.byProvider[providerId]
      ?? (this.byProvider[providerId] = { requests: 0, errors: 0, latencyMs: 0, tokens: 0 })
    row.requests += 1
    if (!ok) row.errors += 1
    row.latencyMs += latencyMs
    row.tokens += Number(usage?.total_tokens ?? 0) || 0
  }

  snapshot(): GatewayMetricsSnapshot {
    return { requests: this.requests, errors: this.errors, byProvider: { ...this.byProvider } }
  }
}

export interface GatewayHandle {
  url: string
  port: number
  token: string
  router: GatewayRouter
  plugins: string[]
  metrics: { snapshot(): GatewayMetricsSnapshot }
  close(): Promise<void>
}

interface ForwardResult {
  status: number
  body: string
  contentType: string
  usage?: Usage
}

const MAX_BODY_BYTES = 10 * 1024 * 1024

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function sendRaw(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType })
  res.end(body)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function authorized(req: IncomingMessage, token: string): boolean {
  return (req.headers.authorization ?? '') === `Bearer ${token}`
}

function authHeaders(provider: GatewayProvider, key: string): Record<string, string> {
  if (provider.auth === 'none') return {}
  if (provider.auth === 'x-api-key') return key ? { 'x-api-key': key } : {}
  if (provider.auth === 'header' && provider.authHeader) return key ? { [provider.authHeader]: key } : {}
  return key ? { authorization: `Bearer ${key}` } : {}
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(block => {
      if (typeof block === 'string') return block
      const typed = block as { type?: string; text?: unknown }
      return typed?.type === 'text' ? String(typed.text ?? '') : ''
    }).join('')
  }
  return ''
}

/** Restore placeholders inside one SSE `data:` line; other lines pass through. */
export function maskSseLine(line: string, masker: Masker): string {
  const match = /^data:(.*)$/.exec(line.replace(/\r?\n$/, ''))
  if (!match) return line
  const payload = match[1]!.trim()
  if (!payload || payload === '[DONE]') return line
  try {
    return `data: ${JSON.stringify(deepUnmask(JSON.parse(payload), masker))}\n`
  } catch {
    return line
  }
}

/** Anthropic Messages request -> OpenAI chat request (text only). */
function anthropicToOpenAI(body: Record<string, unknown>): Record<string, unknown> {
  const messages: { role: string; content: string }[] = []
  const system = body.system
  if (typeof system === 'string' && system.trim()) {
    messages.push({ role: 'system', content: system })
  } else if (Array.isArray(system)) {
    const joined = system.map(block => (typeof block === 'string' ? block : String((block as { text?: unknown })?.text ?? ''))).join('\n').trim()
    if (joined) messages.push({ role: 'system', content: joined })
  }
  for (const message of Array.isArray(body.messages) ? body.messages as Record<string, unknown>[] : []) {
    if (!message || typeof message !== 'object') continue
    messages.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: textOf(message.content) })
  }
  const out: Record<string, unknown> = { model: typeof body.model === 'string' ? body.model : '', messages }
  for (const key of ['max_tokens', 'temperature', 'top_p', 'stop']) {
    if (body[key] != null) out[key] = body[key]
  }
  return out
}

/** OpenAI chat response -> Anthropic Messages response. */
function openAIToAnthropic(json: unknown, model: string): Record<string, unknown> {
  const record = (json ?? {}) as {
    id?: string
    choices?: { message?: { content?: unknown }; finish_reason?: string }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const choice = record.choices?.[0]
  const stopMap: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'end_turn' }
  return {
    id: record.id ?? `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: textOf(choice?.message?.content) }],
    stop_reason: choice?.finish_reason ? (stopMap[choice.finish_reason] ?? 'end_turn') : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: record.usage?.prompt_tokens ?? 0, output_tokens: record.usage?.completion_tokens ?? 0 },
  }
}

/** Gemini generateContent request -> OpenAI chat request. */
function geminiToOpenAI(body: Record<string, unknown>): Record<string, unknown> {
  const messages: { role: string; content: string }[] = []
  const system = body.systemInstruction as { parts?: { text?: unknown }[] } | undefined
  const systemText = system?.parts?.map(part => String(part?.text ?? '')).join('\n').trim()
  if (systemText) messages.push({ role: 'system', content: systemText })
  for (const content of Array.isArray(body.contents) ? body.contents as Record<string, unknown>[] : []) {
    const parts = Array.isArray(content.parts) ? content.parts as { text?: unknown }[] : []
    messages.push({ role: content.role === 'model' ? 'assistant' : 'user', content: parts.map(part => String(part?.text ?? '')).join('') })
  }
  const generation = (body.generationConfig ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = { model: typeof body.model === 'string' ? body.model : '', messages }
  if (generation.temperature != null) out.temperature = generation.temperature
  if (generation.topP != null) out.top_p = generation.topP
  if (generation.maxOutputTokens != null) out.max_tokens = generation.maxOutputTokens
  if (generation.stopSequences != null) out.stop = generation.stopSequences
  return out
}

/** OpenAI chat response -> Gemini generateContent response. */
function openAIToGemini(json: unknown): Record<string, unknown> {
  const record = (json ?? {}) as {
    choices?: { message?: { content?: unknown }; finish_reason?: string }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  }
  const choice = record.choices?.[0]
  const finishMap: Record<string, string> = { stop: 'STOP', length: 'MAX_TOKENS', tool_calls: 'STOP', content_filter: 'SAFETY' }
  return {
    candidates: [{
      content: { role: 'model', parts: [{ text: textOf(choice?.message?.content) }] },
      finishReason: choice?.finish_reason ? (finishMap[choice.finish_reason] ?? 'STOP') : 'STOP',
    }],
    usageMetadata: {
      promptTokenCount: record.usage?.prompt_tokens ?? 0,
      candidatesTokenCount: record.usage?.completion_tokens ?? 0,
      totalTokenCount: record.usage?.total_tokens ?? 0,
    },
  }
}

interface ProtocolOptions {
  protocol: string
  upstreamPath: string
  transformReq?: (body: Record<string, unknown>) => Record<string, unknown>
  transformRes?: (json: unknown, model: string) => Record<string, unknown>
}

/**
 * Start the gateway. Endpoints:
 * - `GET  /health`              (no auth) — providers + cooldowns + metrics + plugins
 * - `GET  /v1/models`           — model catalog + routing aliases
 * - `GET  /v1/gateway/quotas`   — usage/quota snapshot
 * - `POST /v1/chat/completions` — OpenAI chat (JSON + SSE)
 * - `POST /v1/responses`        — OpenAI Responses (pass-through)
 * - `POST /v1/messages`         — Anthropic Messages (translated to chat)
 * - `POST /v1/embeddings`       — embeddings (pass-through)
 * - `POST /v1beta/models/{m}:generateContent` — Gemini (translated to chat)
 */
export async function startGatewayServer(config: GatewayConfig): Promise<GatewayHandle> {
  const router = new GatewayRouter(config.providers, config.defaultModel, () => Date.now(), config.aliases ?? {})
  const metrics = new GatewayMetrics()
  const plugins = new PluginHost()
  plugins.register(strategyPlugin())
  if (config.masking) plugins.register(maskingPlugin())
  if (config.home) {
    await plugins.loadFromDir(path.join(config.home, 'gateway-plugins'), path.join(config.home, 'gateway.plugins.json'))
  }
  const limits = new GatewayLimits(id => {
    const provider = config.providers.find(item => item.id === id)
    return { maxConcurrency: provider?.maxConcurrency, maxRpm: provider?.maxRpm, dailyTokens: provider?.dailyTokens }
  })
  const usage = new UsageLedger()
  const recordUsage = (row: UsageRow): void => {
    usage.record(row)
    plugins.runUsage(row as unknown as JsonObject)
  }
  const affinity = new Affinity()
  const firstUserText = (body: Record<string, unknown>): string => {
    for (const message of Array.isArray(body.messages) ? body.messages as Record<string, unknown>[] : []) {
      if (message && message.role === 'user') return typeof message.content === 'string' ? message.content : textOf(message.content)
    }
    return ''
  }
  const sessionIdOf = (req: IncomingMessage, body: Record<string, unknown>): string | undefined => {
    const header = req.headers['x-gateway-session'] ?? req.headers['x-conversation-id']
    if (typeof header === 'string' && header.trim()) return header.trim()
    const text = firstUserText(body)
    if (!text.trim()) return undefined
    return `magpie-${createHash('sha256').update(text).digest('hex').slice(0, 16)}`
  }

  const forward = async (
    provider: GatewayProvider,
    upstreamPath: string,
    body: Record<string, unknown>,
    model: string,
    stream: boolean,
    clientRes: ServerResponse,
    key: string,
    streamMasker?: Masker,
  ): Promise<'streamed' | ForwardResult> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), provider.timeoutMs ?? 60_000)
    try {
      const payload: Record<string, unknown> = { ...body, model }
      if (upstreamPath.endsWith('/chat/completions') || upstreamPath.endsWith('/responses')) payload.stream = stream
      const response = await fetch(upstreamUrl(provider, upstreamPath), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', ...authHeaders(provider, key), ...(provider.headers ?? {}) },
        body: JSON.stringify(payload),
      })
      const contentType = response.headers.get('content-type') ?? 'application/json'
      if (stream && response.ok && contentType.includes('text/event-stream') && response.body) {
        clientRes.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const reader = response.body.getReader()
        if (streamMasker) {
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let index: number
            while ((index = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, index + 1)
              buffer = buffer.slice(index + 1)
              clientRes.write(maskSseLine(line, streamMasker))
            }
          }
          if (buffer) clientRes.write(maskSseLine(buffer, streamMasker))
        } else {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            clientRes.write(Buffer.from(value))
          }
        }
        clientRes.end()
        return 'streamed'
      }
      const text = await response.text()
      let usage: Usage | undefined
      try {
        usage = (JSON.parse(text) as { usage?: Usage }).usage
      } catch {
        usage = undefined
      }
      return { status: response.status, body: text, contentType, ...(usage ? { usage } : {}) }
    } finally {
      clearTimeout(timer)
    }
  }

  const applyStrategy = (candidates: ReturnType<GatewayRouter['candidates']>, routing?: string) => {
    if (!routing) return candidates
    const strategy = plugins.strategies()[routing]
    if (!strategy) return candidates
    const cooling = new Map(router.providersState().map(state => [state.id, Boolean(state.cooldownUntil)]))
    const stats = new Map<string, { requests: number; latencyMs: number }>()
    for (const bucket of usage.summary().byProviderModel) {
      const entry = stats.get(bucket.provider) ?? { requests: 0, latencyMs: 0 }
      entry.requests += bucket.requests
      entry.latencyMs += bucket.latencyMs
      stats.set(bucket.provider, entry)
    }
    const seats: RouteSeat[] = candidates.map((candidate, index) => {
      const stat = stats.get(candidate.provider.id)
      return {
        index,
        provider: candidate.provider.id,
        model: candidate.model,
        priority: candidate.provider.priority ?? 0,
        cooling: cooling.get(candidate.provider.id) ?? false,
        cost: candidate.provider.cost ?? 0,
        requests: stat?.requests ?? 0,
        ...(stat && stat.requests > 0 ? { avgLatencyMs: stat.latencyMs / stat.requests } : {}),
      }
    })
    try {
      const order = strategy(seats, {})
      if (!Array.isArray(order) || order.length !== candidates.length) return candidates
      return order.map(index => candidates[index]).filter((item): item is (typeof candidates)[number] => item != null)
    } catch {
      return candidates
    }
  }

  /** Try each candidate provider; fall back on 5xx/429/network, return the winning result. */
  const routeForward = async (
    res: ServerResponse,
    upstreamPath: string,
    body: Record<string, unknown>,
    stream: boolean,
    modelInput: string | undefined,
    protocol: string,
    session?: string,
    routing?: string,
    streamMasker?: Masker,
  ): Promise<'streamed' | ForwardResult> => {
    const candidates = applyStrategy(router.candidates(modelInput), routing)
    if (session) {
      const pinned = affinity.get(session)
      if (pinned) {
        const index = candidates.findIndex(candidate => candidate.provider.id === pinned)
        if (index > 0) {
          const [chosen] = candidates.splice(index, 1)
          if (chosen) candidates.unshift(chosen)
        }
      }
    }
    if (candidates.length === 0) {
      return { status: 503, body: JSON.stringify({ error: { message: 'no upstream provider configured' } }), contentType: 'application/json' }
    }
    const errors: string[] = []
    let attempted = 0
    let rateLimited = false
    for (const candidate of candidates) {
      if (!limits.acquire(candidate.provider.id)) {
        rateLimited = true
        errors.push(`${candidate.provider.id}: limit`)
        continue
      }
      attempted += 1
      const started = Date.now()
      const key = router.pickKey(candidate.provider)
      try {
        const result = await forward(candidate.provider, upstreamPath, body, candidate.model, stream, res, key, streamMasker)
        const latency = Date.now() - started
        if (result === 'streamed') {
          router.recordSuccess(candidate.provider.id)
          metrics.record(candidate.provider.id, latency, true)
          if (session) affinity.set(session, candidate.provider.id)
          recordUsage({ at: new Date().toISOString(), protocol, provider: candidate.provider.id, model: candidate.model, requested: modelInput, status: 200, latencyMs: latency, tokens: 0, ok: true, routing, session })
          return 'streamed'
        }
        const tokens = Number(result.usage?.total_tokens ?? 0) || 0
        if (result.status >= 500 || result.status === 429 || result.status === 402) {
          router.recordFailure(candidate.provider.id)
          if (result.status === 429 || result.status === 402) limits.rest(candidate.provider.id)
          metrics.record(candidate.provider.id, latency, false, result.usage)
          recordUsage({ at: new Date().toISOString(), protocol, provider: candidate.provider.id, model: candidate.model, requested: modelInput, status: result.status, latencyMs: latency, tokens, ok: false, routing, session })
          errors.push(`${candidate.provider.id}: ${result.status} ${result.body.slice(0, 200)}`)
          continue
        }
        router.recordSuccess(candidate.provider.id)
        limits.recordTokens(candidate.provider.id, tokens)
        metrics.record(candidate.provider.id, latency, true, result.usage)
        if (session) affinity.set(session, candidate.provider.id)
        recordUsage({ at: new Date().toISOString(), protocol, provider: candidate.provider.id, model: candidate.model, requested: modelInput, status: result.status, latencyMs: latency, tokens, ok: true, routing, session })
        return result
      } catch (error) {
        router.recordFailure(candidate.provider.id)
        metrics.record(candidate.provider.id, Date.now() - started, false)
        recordUsage({ at: new Date().toISOString(), protocol, provider: candidate.provider.id, model: candidate.model, requested: modelInput, status: 0, latencyMs: Date.now() - started, tokens: 0, ok: false, routing, session })
        errors.push(`${candidate.provider.id}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      } finally {
        limits.release(candidate.provider.id)
      }
    }
    if (attempted === 0 && rateLimited) {
      const retryAfterMs = Math.min(...candidates.map(candidate => limits.retryAfterMs(candidate.provider.id)))
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))))
      return {
        status: 429,
        body: JSON.stringify({ error: { message: 'all providers are rate-limited or exhausted', retryAfterMs } }),
        contentType: 'application/json',
      }
    }
    return { status: 502, body: JSON.stringify({ error: { message: 'all upstream providers failed', details: errors } }), contentType: 'application/json' }
  }

  const readJson = async (req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> => {
    const raw = await readBody(req)
    try {
      return JSON.parse(raw || '{}') as Record<string, unknown>
    } catch {
      sendJson(res, 400, { error: { message: 'request body is not valid JSON' } })
      return undefined
    }
  }
  const modelOf = (body: Record<string, unknown>): string | undefined => typeof body.model === 'string' ? body.model : undefined

  const handleProtocol = async (req: IncomingMessage, res: ServerResponse, options: ProtocolOptions): Promise<void> => {
    let body = await readJson(req, res)
    if (!body) return
    if (options.transformReq) body = options.transformReq(body)
    const model = modelOf(body)
    const state: Record<string, unknown> = {}
    body = await plugins.runRequest(body, { protocol: options.protocol, model }, state)
    const streamMasker = config.masking && state.masker instanceof Masker ? state.masker : undefined
    const stream = body.stream === true
      && (options.upstreamPath.endsWith('/chat/completions') || options.upstreamPath.endsWith('/responses'))
    const routing = typeof req.headers['x-gateway-routing'] === 'string' ? req.headers['x-gateway-routing'] : undefined
    const session = sessionIdOf(req, body)
    const result = await routeForward(res, options.upstreamPath, body, stream, modelOf(body), options.protocol, session, routing, streamMasker)
    if (result === 'streamed') return
    let outBody = result.body
    if (result.status < 400 && options.transformRes) {
      try {
        outBody = JSON.stringify(options.transformRes(JSON.parse(result.body), model ?? ''))
      } catch {
        // Keep the provider's raw body.
      }
    }
    if (result.status < 400) {
      try {
        outBody = JSON.stringify(await plugins.runResponse(JSON.parse(outBody) as JsonObject, { protocol: options.protocol, model, status: result.status }, state))
      } catch {
        // Keep the body as it was.
      }
    }
    sendRaw(res, result.status, outBody, result.contentType || 'application/json')
  }

  const handleGemini = async (req: IncomingMessage, res: ServerResponse, method: string): Promise<void> => {
    if (method === 'streamGenerateContent') {
      sendJson(res, 501, { error: { message: 'streamGenerateContent is not supported yet; use generateContent' } })
      return
    }
    await handleProtocol(req, res, {
      protocol: 'gemini',
      upstreamPath: '/chat/completions',
      transformReq: geminiToOpenAI,
      transformRes: json => openAIToGemini(json),
    })
  }

  const handleQuotas = (_req: IncomingMessage, res: ServerResponse): void => {
    sendJson(res, 200, {
      object: 'gateway.quotas',
      generatedAt: new Date().toISOString(),
      providers: router.providersState(),
      plugins: plugins.list(),
      limits: config.providers.map(provider => ({ id: provider.id, ...limits.snapshot(provider.id) })),
      usage: usage.summary(),
      metrics: metrics.snapshot(),
    })
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local')
    if (url.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, providers: router.providersState(), plugins: plugins.list(), metrics: metrics.snapshot() })
      return
    }
    if (!authorized(req, config.token)) {
      sendJson(res, 401, { error: { message: 'invalid gateway token' } })
      return
    }
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      sendJson(res, 200, {
        object: 'list',
        data: router.listModels().map(model => ({ id: model.id, object: 'model', owned_by: model.provider })),
      })
      return
    }
    if (url.pathname === '/v1/gateway/quotas' && req.method === 'GET') {
      handleQuotas(req, res)
      return
    }
    if (url.pathname === '/v1/gateway/usage' && req.method === 'GET') {
      const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit') ?? 100) || 100))
      sendJson(res, 200, { object: 'gateway.usage', summary: usage.summary(), recent: usage.recent(limit) })
      return
    }
    if (url.pathname === '/v1/gateway/sessions' && req.method === 'GET') {
      sendJson(res, 200, { object: 'gateway.sessions', sessions: usage.summaryBySession() })
      return
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      await handleProtocol(req, res, { protocol: 'chat', upstreamPath: '/chat/completions' })
      return
    }
    if (url.pathname === '/v1/embeddings' && req.method === 'POST') {
      await handleProtocol(req, res, { protocol: 'embeddings', upstreamPath: '/embeddings' })
      return
    }
    if (url.pathname === '/v1/responses' && req.method === 'POST') {
      await handleProtocol(req, res, { protocol: 'responses', upstreamPath: '/responses' })
      return
    }
    if (url.pathname === '/v1/messages' && req.method === 'POST') {
      await handleProtocol(req, res, {
        protocol: 'anthropic',
        upstreamPath: '/chat/completions',
        transformReq: anthropicToOpenAI,
        transformRes: (json, model) => openAIToAnthropic(json, model),
      })
      return
    }
    const gemini = /^\/v1beta\/models\/(.+?):(generateContent|streamGenerateContent)$/.exec(url.pathname)
    if (gemini && req.method === 'POST') {
      await handleGemini(req, res, gemini[2]!)
      return
    }
    sendJson(res, 404, { error: { message: `not found: ${req.method ?? 'GET'} ${url.pathname}` } })
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (!res.headersSent) sendJson(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } })
      else res.end()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => resolve())
  })
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : config.port
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host

  return {
    url: `http://${host}:${port}`,
    port,
    token: config.token,
    router,
    plugins: plugins.list(),
    metrics: { snapshot: () => metrics.snapshot() },
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    }),
  }
}

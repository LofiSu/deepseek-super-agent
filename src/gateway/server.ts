import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { GatewayConfig, GatewayProvider } from './config.ts'
import { upstreamUrl } from './config.ts'
import { GatewayRouter } from './router.ts'

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

/** How the credential reaches the upstream (bearer / x-api-key / custom header). */
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

/** Minimal Anthropic Messages request -> OpenAI chat request translation (text only). */
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

/** Minimal OpenAI chat response -> Anthropic Messages response translation. */
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

/**
 * Start the gateway. Endpoints:
 * - `GET  /health`              (no auth) — providers + cooldowns + metrics
 * - `GET  /v1/models`           — model catalog + routing aliases
 * - `GET  /v1/gateway/quotas`   — usage/quota snapshot
 * - `POST /v1/chat/completions` — OpenAI chat (JSON + SSE)
 * - `POST /v1/responses`        — OpenAI Responses (pass-through)
 * - `POST /v1/messages`         — Anthropic Messages (translated to chat)
 * - `POST /v1/embeddings`       — embeddings (pass-through)
 */
export async function startGatewayServer(config: GatewayConfig): Promise<GatewayHandle> {
  const router = new GatewayRouter(config.providers, config.defaultModel, () => Date.now(), config.aliases ?? {})
  const metrics = new GatewayMetrics()

  const forward = async (
    provider: GatewayProvider,
    path: string,
    body: Record<string, unknown>,
    model: string,
    stream: boolean,
    clientRes: ServerResponse,
    key: string,
  ): Promise<'streamed' | ForwardResult> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), provider.timeoutMs ?? 60_000)
    try {
      const payload: Record<string, unknown> = { ...body, model }
      if (path.endsWith('/chat/completions') || path.endsWith('/responses')) payload.stream = stream
      const response = await fetch(upstreamUrl(provider, path), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...authHeaders(provider, key),
          ...(provider.headers ?? {}),
        },
        body: JSON.stringify(payload),
      })
      const contentType = response.headers.get('content-type') ?? 'application/json'
      if (stream && response.ok && contentType.includes('text/event-stream') && response.body) {
        clientRes.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          clientRes.write(Buffer.from(value))
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

  /** Try each candidate provider; fall back on 5xx/429/network, return the winning result. */
  const routeForward = async (
    res: ServerResponse,
    upstreamPath: string,
    body: Record<string, unknown>,
    stream: boolean,
    modelInput: string | undefined,
  ): Promise<'streamed' | ForwardResult> => {
    const candidates = router.candidates(modelInput)
    if (candidates.length === 0) {
      return { status: 503, body: JSON.stringify({ error: { message: 'no upstream provider configured' } }), contentType: 'application/json' }
    }
    const errors: string[] = []
    for (const candidate of candidates) {
      const started = Date.now()
      const key = router.pickKey(candidate.provider)
      try {
        const result = await forward(candidate.provider, upstreamPath, body, candidate.model, stream, res, key)
        const latency = Date.now() - started
        if (result === 'streamed') {
          router.recordSuccess(candidate.provider.id)
          metrics.record(candidate.provider.id, latency, true)
          return 'streamed'
        }
        if (result.status >= 500 || result.status === 429) {
          router.recordFailure(candidate.provider.id)
          metrics.record(candidate.provider.id, latency, false, result.usage)
          errors.push(`${candidate.provider.id}: ${result.status} ${result.body.slice(0, 200)}`)
          continue
        }
        router.recordSuccess(candidate.provider.id)
        metrics.record(candidate.provider.id, latency, true, result.usage)
        return result
      } catch (error) {
        router.recordFailure(candidate.provider.id)
        metrics.record(candidate.provider.id, Date.now() - started, false)
        errors.push(`${candidate.provider.id}: ${error instanceof Error ? error.message : String(error)}`)
        continue
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
  const modelOf = (body: Record<string, unknown>): string | undefined =>
    typeof body.model === 'string' ? body.model : undefined

  const handleChat = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJson(req, res)
    if (!body) return
    const result = await routeForward(res, '/chat/completions', body, body.stream === true, modelOf(body))
    if (result !== 'streamed') sendRaw(res, result.status, result.body, result.contentType)
  }

  const handleEmbeddings = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJson(req, res)
    if (!body) return
    const result = await routeForward(res, '/embeddings', body, false, modelOf(body))
    if (result !== 'streamed') sendRaw(res, result.status, result.body, result.contentType)
  }

  const handleResponses = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJson(req, res)
    if (!body) return
    const result = await routeForward(res, '/responses', body, body.stream === true, modelOf(body))
    if (result !== 'streamed') sendRaw(res, result.status, result.body, result.contentType)
  }

  const handleMessages = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJson(req, res)
    if (!body) return
    const chatBody = anthropicToOpenAI(body)
    const model = typeof chatBody.model === 'string' ? chatBody.model : undefined
    const result = await routeForward(res, '/chat/completions', chatBody, false, model)
    if (result === 'streamed') return
    if (result.status >= 400) {
      sendRaw(res, result.status, result.body, result.contentType)
      return
    }
    try {
      sendJson(res, 200, openAIToAnthropic(JSON.parse(result.body), model ?? 'unknown'))
    } catch {
      sendRaw(res, result.status, result.body, result.contentType)
    }
  }

  const handleQuotas = (_req: IncomingMessage, res: ServerResponse): void => {
    sendJson(res, 200, {
      object: 'gateway.quotas',
      generatedAt: new Date().toISOString(),
      providers: router.providersState(),
      metrics: metrics.snapshot(),
    })
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local')
    if (url.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, providers: router.providersState(), metrics: metrics.snapshot() })
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
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      await handleChat(req, res)
      return
    }
    if (url.pathname === '/v1/embeddings' && req.method === 'POST') {
      await handleEmbeddings(req, res)
      return
    }
    if (url.pathname === '/v1/responses' && req.method === 'POST') {
      await handleResponses(req, res)
      return
    }
    if (url.pathname === '/v1/messages' && req.method === 'POST') {
      await handleMessages(req, res)
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
    metrics: { snapshot: () => metrics.snapshot() },
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    }),
  }
}

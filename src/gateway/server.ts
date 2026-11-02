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
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
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

/**
 * Start an OpenAI-compatible gateway. Endpoints:
 * - `GET /health`            (no auth) — providers + cooldowns
 * - `GET /v1/models`         — aggregated catalog
 * - `POST /v1/chat/completions` — routed upstream call, with fallback
 */
export async function startGatewayServer(config: GatewayConfig): Promise<GatewayHandle> {
  const router = new GatewayRouter(config.providers, config.defaultModel)
  const metrics = new GatewayMetrics()

  const forward = async (
    provider: GatewayProvider,
    body: Record<string, unknown>,
    model: string,
    stream: boolean,
    clientRes: ServerResponse,
  ): Promise<'streamed' | ForwardResult> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), provider.timeoutMs ?? 60_000)
    try {
      const response = await fetch(upstreamUrl(provider, '/chat/completions'), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
          ...(provider.headers ?? {}),
        },
        body: JSON.stringify({ ...body, model, stream }),
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
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      await handleChat(req, res)
      return
    }
    sendJson(res, 404, { error: { message: `not found: ${req.method ?? 'GET'} ${url.pathname}` } })
  }

  const handleChat = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const raw = await readBody(req)
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw || '{}') as Record<string, unknown>
    } catch {
      sendJson(res, 400, { error: { message: 'request body is not valid JSON' } })
      return
    }
    const stream = body.stream === true
    const requestedModel = typeof body.model === 'string' ? body.model : undefined
    const candidates = router.candidates(requestedModel)
    if (candidates.length === 0) {
      sendJson(res, 503, { error: { message: 'no upstream provider configured' } })
      return
    }
    const errors: string[] = []
    for (const candidate of candidates) {
      const started = Date.now()
      try {
        const result = await forward(candidate.provider, body, candidate.model, stream, res)
        const latency = Date.now() - started
        if (result === 'streamed') {
          router.recordSuccess(candidate.provider.id)
          metrics.record(candidate.provider.id, latency, true)
          return
        }
        // Retry another provider only for upstream faults; surface client errors as-is.
        if (result.status >= 500 || result.status === 429) {
          router.recordFailure(candidate.provider.id)
          metrics.record(candidate.provider.id, latency, false, result.usage)
          errors.push(`${candidate.provider.id}: ${result.status} ${result.body.slice(0, 200)}`)
          continue
        }
        router.recordSuccess(candidate.provider.id)
        metrics.record(candidate.provider.id, latency, true, result.usage)
        sendRaw(res, result.status, result.body, result.contentType)
        return
      } catch (error) {
        router.recordFailure(candidate.provider.id)
        metrics.record(candidate.provider.id, Date.now() - started, false)
        errors.push(`${candidate.provider.id}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
    }
    sendJson(res, 502, { error: { message: 'all upstream providers failed', details: errors } })
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

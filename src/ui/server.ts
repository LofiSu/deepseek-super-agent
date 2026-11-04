import { createHash, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { ticketStage } from '../core/stage.ts'
import type { Metrics, MetricsSnapshot } from '../metrics/metrics.ts'
import type { OutboxRow, Thread, Ticket } from '../shared/types.ts'
import type { Store } from '../store/sqlite.ts'
import { healthProbe } from '../watchdog/health.ts'
import { renderHtml } from './render.ts'

/** The local UI only ever binds loopback. */
export const UI_HOST = '127.0.0.1'
export const DEFAULT_UI_PORT = 4318

/** Browser cookie used after the `GET /?token=` bootstrap. */
export const AUTH_COOKIE = 'ds_ui_token'
export const MIN_TOKEN_LENGTH = 16

/** How many lifecycle events the snapshot and page include. */
export const SNAPSHOT_EVENT_LIMIT = 50

/** SSE refresh cadence. Only the server pushes; clients have no write path. */
export const SNAPSHOT_INTERVAL_MS = 2_000

/**
 * Restrictive CSP for the server-rendered page. There are no external assets;
 * the only script is the inline SSE bootstrap. `default-src 'none'` blocks
 * everything else, and `script-src 'unsafe-inline'` is what allows that one
 * inline bootstrap to run.
 */
export const HTML_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1'
    || normalized === '[::1]'
}

export interface SnapshotTicket {
  id: string
  title: string
  stage: string
  ended: boolean
  paused: boolean
  createdAt: string
}

export interface SnapshotThread {
  key: string
  subscriptions: string[]
  pending: number
  deferred: boolean
  lastAt?: string
}

export interface SnapshotOutbox {
  id: string
  ticketId: string
  status: OutboxRow['status']
  channel: string
  thread: string
  attempts: number
  createdAt: string
}

export interface SnapshotHealth {
  store: string
  vaultMode: 'absent' | 'ok' | 'insecure'
  machinesOnline: number
  watchdogIdle: boolean
}

export interface SnapshotEvent {
  kind: string
  payload: unknown
}

/** One read model shared by the HTML page, `/api/snapshot`, and SSE. */
export interface UiSnapshot {
  generatedAt: string
  tickets: SnapshotTicket[]
  threads: SnapshotThread[]
  outbox: SnapshotOutbox[]
  health: SnapshotHealth
  metrics: MetricsSnapshot
  events: SnapshotEvent[]
}

/**
 * Build the read-only view from persisted state. Every surface calls this
 * function so the HTML page, JSON API, and SSE stream cannot drift.
 */
export function buildSnapshot(
  store: Store,
  metrics: Metrics,
  home: string,
  opts: { eventLimit?: number } = {},
): UiSnapshot {
  const tickets = store.listDocs<Ticket>('ticket')
    .filter(ticket => ticket.speculative !== true)
    .map(ticket => ({
    id: ticket.id,
    title: ticket.title,
    stage: ticketStage(ticket),
    ended: ticket.ended != null,
    paused: ticket.collab?.paused != null,
    createdAt: ticket.createdAt,
  }))

  // Threads live in two places: a persisted Thread document (pending/correlated
  // state) and the subscription table. Show the union so a subscription seeded
  // by the Engine is visible even before a Thread document exists.
  const threadDocs = new Map<string, Thread>()
  for (const thread of store.listDocs<Thread>('thread')) threadDocs.set(thread.key, thread)
  const subscribed = new Map<string, Set<string>>()
  for (const row of store.listSubscriptions()) {
    let ticketIds = subscribed.get(row.threadKey)
    if (!ticketIds) {
      ticketIds = new Set<string>()
      subscribed.set(row.threadKey, ticketIds)
    }
    ticketIds.add(row.ticketId)
  }
  const threadKeys = new Set<string>([...threadDocs.keys(), ...subscribed.keys()])
  const threads = [...threadKeys].sort().map(key => {
    const thread = threadDocs.get(key)
    const subscriptions = new Set<string>(thread?.subscriptions ?? [])
    for (const ticketId of subscribed.get(key) ?? []) subscriptions.add(ticketId)
    const view: SnapshotThread = {
      key,
      subscriptions: [...subscriptions].sort(),
      pending: thread?.pending?.length ?? 0,
      deferred: thread?.deferred === true,
    }
    if (thread?.lastAt) view.lastAt = thread.lastAt
    return view
  })

  const outbox = store.listOutbox().map(row => ({
    id: row.id,
    ticketId: row.ticketId,
    status: row.status,
    channel: row.channel,
    thread: row.thread,
    attempts: row.attempts ?? 0,
    createdAt: row.createdAt,
  }))

  const eventLimit = opts.eventLimit ?? SNAPSHOT_EVENT_LIMIT
  return {
    generatedAt: new Date().toISOString(),
    tickets,
    threads,
    outbox,
    health: healthProbe(store, home),
    metrics: metrics.snapshot(),
    events: store.recentLifecycleEvents(eventLimit).map(event => ({
      kind: event.kind,
      payload: event.payload,
    })),
  }
}

/**
 * Accept only the Host values a browser reaches at loopback. This is a
 * DNS-rebinding guard, not authentication: the bind is loopback-only.
 */
export function isAllowedHostHeader(value: string | string[] | undefined): boolean {
  if (typeof value !== 'string') return false
  const host = value.trim().toLowerCase()
  if (host.length === 0) return false
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    if (end < 0) return false
    if (host.slice(0, end + 1) !== '[::1]') return false
    const suffix = host.slice(end + 1)
    return suffix === '' || /^:\d+$/u.test(suffix)
  }
  const parts = host.split(':')
  if (parts.length > 2) return false
  const [hostname, port] = parts
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') return false
  return port === undefined || /^\d+$/u.test(port)
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/** Constant-time token comparison over fixed-length SHA-256 digests. */
function tokenMatches(presented: string | undefined, expected: string): boolean {
  return timingSafeEqual(sha256(presented ?? ''), sha256(expected))
}

function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined
  const match = /^Bearer[ \t]+(.+)$/iu.exec(header.trim())
  return match?.[1]?.trim()
}

function cookieValue(header: string | string[] | undefined, name: string): string | undefined {
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    const raw = part.slice(index + 1).trim()
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return undefined
}

function isAuthorized(req: http.IncomingMessage, token: string): boolean {
  const presented = bearerToken(req.headers.authorization)
    ?? cookieValue(req.headers.cookie, AUTH_COOKIE)
  return tokenMatches(presented, token)
}

export interface UiServerOptions {
  home: string
  store: Store
  metrics: Metrics
  /** Required bearer token; at least MIN_TOKEN_LENGTH characters. */
  token: string
  host?: string
  port?: number
  eventIntervalMs?: number
  eventLimit?: number
}

export interface UiServerHandle {
  url: string
  port: number
  close(): Promise<void>
}

/**
 * Start the read-only local UI. The caller owns `store` and `metrics`; this
 * function never constructs a model, starts the daemon, or writes domain docs.
 */
export async function startUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  const host = options.host ?? UI_HOST
  if (!isLoopbackHost(host)) {
    throw new Error(`ui refuses non-loopback host ${host}; bind 127.0.0.1`)
  }
  const token = (options.token ?? '').trim()
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `ui requires a token of at least ${MIN_TOKEN_LENGTH} characters `
      + '(DS_AGENT_UI_TOKEN or --token); refusing to start',
    )
  }
  const port = options.port ?? DEFAULT_UI_PORT
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid ui port: ${port}`)
  }
  const intervalMs = options.eventIntervalMs ?? SNAPSHOT_INTERVAL_MS
  const eventLimit = options.eventLimit ?? SNAPSHOT_EVENT_LIMIT
  const sseClients = new Set<http.ServerResponse>()
  let closing = false

  const snapshot = (): UiSnapshot => buildSnapshot(options.store, options.metrics, options.home, { eventLimit })

  const server = http.createServer((req, res) => {
    if (!isAllowedHostHeader(req.headers.host)) {
      sendText(res, 403, 'forbidden\n')
      return
    }

    let url: URL
    try {
      url = new URL(req.url ?? '/', `http://${UI_HOST}`)
    } catch {
      sendText(res, 400, 'bad request\n')
      return
    }
    const pathname = url.pathname

    // Browser bootstrap: the token appears in the address bar once, is
    // exchanged for an HttpOnly cookie, and the redirect lands on a clean `/`.
    if (pathname === '/' && req.method === 'GET') {
      const queryToken = url.searchParams.get('token')
      if (queryToken !== null) {
        if (!tokenMatches(queryToken, token)) {
          sendText(res, 401, 'unauthorized\n')
          return
        }
        res.writeHead(303, {
          ...SECURITY_HEADERS,
          'set-cookie': `${AUTH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
          location: '/',
        })
        res.end()
        return
      }
    }

    // Liveness only: no auth and no state.
    if (pathname === '/health' && req.method === 'GET') {
      sendText(res, 200, '{"ok":true}', { 'content-type': 'application/json; charset=utf-8' })
      return
    }

    // Auth precedes routing so an unknown path cannot be probed without a token.
    if (!isAuthorized(req, token)) {
      sendText(res, 401, 'unauthorized\n')
      return
    }
    if (req.method !== 'GET') {
      sendText(res, 405, 'method not allowed\n', { allow: 'GET' })
      return
    }

    if (pathname === '/') {
      let html: string
      try {
        html = renderHtml(snapshot())
      } catch (error) {
        sendText(res, 500, `snapshot failed: ${errorMessage(error)}\n`)
        return
      }
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': HTML_CSP,
        'referrer-policy': 'no-referrer',
      })
      res.end(html)
      return
    }

    if (pathname === '/api/snapshot') {
      let body: string
      try {
        body = JSON.stringify(snapshot())
      } catch (error) {
        sendText(res, 500, `snapshot failed: ${errorMessage(error)}\n`)
        return
      }
      sendText(res, 200, body, { 'content-type': 'application/json; charset=utf-8' })
      return
    }

    if (pathname === '/api/events') {
      streamEvents(req, res)
      return
    }

    sendText(res, 404, 'not found\n')
  })

  function streamEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (closing) {
      sendText(res, 503, 'shutting down\n')
      return
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    sseClients.add(res)
    let timer: NodeJS.Timeout | undefined
    const cleanup = (): void => {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
      sseClients.delete(res)
    }
    const writeFrame = (): void => {
      if (res.writableEnded || res.destroyed) {
        cleanup()
        return
      }
      let flushed: boolean
      try {
        flushed = res.write(`data: ${JSON.stringify(snapshot())}\n\n`)
      } catch {
        // A broken read model must close the stream, not leave the client
        // waiting for the next frame forever.
        cleanup()
        try {
          res.end()
        } catch {
          // The client may already be gone.
        }
        return
      }
      if (!flushed) {
        // Never let a slow client buffer frames without bound.
        cleanup()
        res.destroy()
      }
    }
    // One immediate frame so a client sees state without waiting 2 s.
    writeFrame()
    if (!res.writableEnded && !res.destroyed) {
      timer = setInterval(writeFrame, intervalMs)
      timer.unref?.()
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
  }

  server.headersTimeout = 10_000
  server.requestTimeout = 30_000
  server.keepAliveTimeout = 5_000

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error)
    }
    server.once('error', onError)
    server.once('listening', () => {
      server.off('error', onError)
      resolve()
    })
    server.listen({ host: UI_HOST, port })
  })
  // Listen failures are surfaced above. Later server errors must not crash the
  // process; the socket layer reports them per connection.
  server.on('error', () => undefined)

  const address = server.address() as AddressInfo
  const actualPort = address.port
  let closed = false

  return {
    url: `http://${UI_HOST}:${actualPort}`,
    port: actualPort,
    async close(): Promise<void> {
      if (closed) return
      closed = true
      closing = true
      for (const client of sseClients) {
        try {
          client.end()
        } catch {
          // The client may already be gone.
        }
      }
      sseClients.clear()
      if (!server.listening) return
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        server.closeAllConnections()
      })
    },
  }
}

function sendText(
  res: http.ServerResponse,
  status: number,
  body: string,
  extra: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'text/plain; charset=utf-8',
    ...extra,
  })
  res.end(body)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

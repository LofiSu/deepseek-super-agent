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
  text: string
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
  const tickets = store.listDocs<Ticket>('ticket').map(ticket => ({
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
    text: row.text,
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
  if (host === '::1' || host === '[::1]') return true
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    if (end < 0) return false
    return host.slice(0, end + 1) === '[::1]'
  }
  const colon = host.lastIndexOf(':')
  const hostname = colon >= 0 ? host.slice(0, colon) : host
  return hostname === '127.0.0.1' || hostname === 'localhost'
}

export interface UiServerOptions {
  home: string
  store: Store
  metrics: Metrics
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
    if (req.method !== 'GET') {
      sendText(res, 405, 'method not allowed\n', { allow: 'GET' })
      return
    }

    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', `http://${UI_HOST}`).pathname
    } catch {
      sendText(res, 400, 'bad request\n')
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
      try {
        res.write(`data: ${JSON.stringify(snapshot())}\n\n`)
      } catch {
        cleanup()
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

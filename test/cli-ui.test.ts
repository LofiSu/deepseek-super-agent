import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { runUi } from '../src/cli/ui.ts'
import { Metrics } from '../src/metrics/metrics.ts'
import type { Thread, Ticket } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'
import {
  HTML_CSP,
  startUiServer,
  type UiServerHandle,
} from '../src/ui/server.ts'

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-ui-'))
}

interface Response {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

function request(
  url: string,
  options: { method?: string; host?: string } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers = options.host ? { host: options.host } : undefined
    const req = http.request(url, { method: options.method ?? 'GET', ...(headers ? { headers } : {}) }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

interface SseFrame {
  req: http.ClientRequest
  headers: http.IncomingHttpHeaders
  frame: string
}

function openSse(url: string): Promise<SseFrame> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let buffer = ''
      res.setEncoding('utf8')
      const onData = (chunk: string): void => {
        buffer += chunk
        const end = buffer.indexOf('\n\n')
        if (end >= 0) {
          res.off('data', onData)
          resolve({ req, headers: res.headers, frame: buffer.slice(0, end) })
        }
      }
      res.on('data', onData)
      res.once('error', reject)
    })
    req.once('error', reject)
  })
}

const TITLE = '<script>alert("escaped")</script> & "quoted"'

function seed(store: Store, metrics: Metrics): void {
  const now = '2026-11-04T10:00:00.000Z'
  const ticket: Ticket = {
    id: 'tkt_ui_1',
    title: TITLE,
    brief: 'verify the local ui',
    mandate: {
      strength: 'explicit',
      policyVersion: 'test',
      scope: 'ui',
      actor: { source: 'im', id: 'sam' },
      basis: 'addressed',
    },
    threadKeys: ['im:thread-1'],
    channels: [],
    inputs: [],
    assignments: [],
    speculative: false,
    originTriggerId: 'trg_ui_1',
    createdAt: now,
  }
  store.putDoc('ticket', ticket.id, ticket)
  store.addSubscription('im:thread-1', ticket.id, now)
  const thread: Thread = {
    key: 'im:thread-1',
    ref: { source: 'im', id: 'thread-1' },
    createdAt: now,
    subscriptions: [ticket.id],
    correlated: [],
    pending: ['trg_pending_1', 'trg_pending_2'],
    meta: {},
  }
  store.putDoc('thread', thread.key, thread)
  store.enqueueOutbox({
    id: 'out_ui_1',
    replyId: 'reply_ui_1',
    ticketId: ticket.id,
    channel: 'im',
    thread: thread.key,
    target: { chat: 'chat_1' },
    text: 'outbox body <unsafe>',
    status: 'pending',
    createdAt: now,
  })
  store.appendLifecycleEvent({
    kind: 'ticket.created',
    payload: { ticketId: ticket.id, title: TITLE },
  })
  metrics.increment('ingress.admit', 2)
  metrics.flush()
}

async function startSeeded(): Promise<{
  home: string
  store: Store
  metrics: Metrics
  server: UiServerHandle
  base: string
}> {
  const home = tempHome()
  const store = new Store(home)
  const metrics = new Metrics(home)
  seed(store, metrics)
  const server = await startUiServer({ home, store, metrics, port: 0 })
  cleanup.push(async () => {
    await server.close()
    if (store.isOpen) store.close()
    fs.rmSync(home, { recursive: true, force: true })
  })
  return { home, store, metrics, server, base: server.url }
}

describe('local UI server', () => {
  it('renders escaped HTML with no external assets', async () => {
    const { base } = await startSeeded()
    const response = await request(`${base}/`)

    expect(response.status).toBe(200)
    expect(String(response.headers['content-type'])).toContain('text/html')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(String(response.headers['content-security-policy'])).toBe(HTML_CSP)

    expect(response.body).toContain('ds-agent local ui')
    expect(response.body).toContain('&lt;script&gt;alert(&quot;escaped&quot;)&lt;/script&gt; &amp; &quot;quoted&quot;')
    expect(response.body).not.toContain(TITLE)
    expect(response.body).toContain('tkt_ui_1')
    expect(response.body).toContain('out_ui_1')
    expect(response.body).toContain('outbox body &lt;unsafe&gt;')
    expect(response.body).toContain('im:thread-1')
    expect(response.body).not.toContain('http://')
    expect(response.body).not.toContain('https://')
  })

  it('serves the same read model through /api/snapshot', async () => {
    const { base, home } = await startSeeded()
    const response = await request(`${base}/api/snapshot`)

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    const snapshot = JSON.parse(response.body) as {
      tickets: { id: string; title: string; stage: string; ended: boolean; paused: boolean; createdAt: string }[]
      threads: { key: string; subscriptions: string[]; pending: number; deferred: boolean }[]
      outbox: { id: string; status: string; channel: string; thread: string; text: string }[]
      health: { store: string; vaultMode: string; watchdogIdle: boolean }
      metrics: { counters: Record<string, number> }
      events: { kind: string; payload: unknown }[]
    }

    expect(snapshot.tickets).toHaveLength(1)
    expect(snapshot.tickets[0]).toMatchObject({
      id: 'tkt_ui_1',
      title: TITLE,
      ended: false,
      paused: false,
      createdAt: '2026-11-04T10:00:00.000Z',
    })
    expect(snapshot.tickets[0]?.stage).toBe('working/queued')

    expect(snapshot.threads).toHaveLength(1)
    expect(snapshot.threads[0]).toMatchObject({
      key: 'im:thread-1',
      subscriptions: ['tkt_ui_1'],
      pending: 2,
      deferred: false,
    })

    expect(snapshot.outbox).toHaveLength(1)
    expect(snapshot.outbox[0]).toMatchObject({
      id: 'out_ui_1',
      status: 'pending',
      channel: 'im',
      thread: 'im:thread-1',
      text: 'outbox body <unsafe>',
    })

    expect(snapshot.health.store).toBe('ok')
    expect(snapshot.health.vaultMode).toBe('absent')
    expect(snapshot.health.watchdogIdle).toBe(true)
    expect(snapshot.metrics.counters['ingress.admit']).toBe(2)
    expect(snapshot.events).toHaveLength(1)
    expect(snapshot.events[0]?.kind).toBe('ticket.created')
    expect(snapshot.events[0]?.payload).toMatchObject({ ticketId: 'tkt_ui_1' })

    // The home path is not part of the public snapshot.
    expect(JSON.stringify(snapshot)).not.toContain(home)
  })

  it('rejects unknown paths and non-GET methods', async () => {
    const { base } = await startSeeded()

    const missing = await request(`${base}/nope`)
    expect(missing.status).toBe(404)
    expect(missing.headers['cache-control']).toBe('no-store')
    expect(missing.headers['x-content-type-options']).toBe('nosniff')

    const post = await request(`${base}/`, { method: 'POST' })
    expect(post.status).toBe(405)
    expect(post.headers.allow).toBe('GET')
    expect(post.headers['cache-control']).toBe('no-store')
    expect(post.headers['x-content-type-options']).toBe('nosniff')
  })

  it('rejects a non-loopback Host header', async () => {
    const { base } = await startSeeded()
    const response = await request(`${base}/`, { host: 'evil.example' })

    expect(response.status).toBe(403)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.body).toContain('forbidden')
  })

  it('streams one snapshot frame over SSE and aborts cleanly', async () => {
    const { base } = await startSeeded()
    const sse = await openSse(`${base}/api/events`)

    expect(sse.headers['content-type']).toContain('text/event-stream')
    expect(sse.headers['cache-control']).toBe('no-store')
    expect(sse.headers['x-content-type-options']).toBe('nosniff')
    expect(sse.frame.startsWith('data: ')).toBe(true)
    const snapshot = JSON.parse(sse.frame.slice('data: '.length)) as { tickets: { id: string }[] }
    expect(snapshot.tickets[0]?.id).toBe('tkt_ui_1')

    // Client close must not leave the timer or response behind.
    sse.req.destroy()
    await new Promise(resolve => setTimeout(resolve, 25))
  })

  it('refuses to bind anything but loopback', async () => {
    const home = tempHome()
    const store = new Store(home)
    const metrics = new Metrics(home)
    cleanup.push(() => {
      if (store.isOpen) store.close()
      fs.rmSync(home, { recursive: true, force: true })
    })
    await expect(runUi(home, { host: '0.0.0.0' })).rejects.toThrow(/only binds loopback/)
    await expect(
      startUiServer({ home, store, metrics, host: '0.0.0.0', port: 0 }),
    ).rejects.toThrow(/non-loopback/)
  })
})

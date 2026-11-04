import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
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

const TOKEN = 'ui-test-token-0123456789abcdef'
const OTHER_TOKEN = 'ui-other-token-0123456789abcd'
const OUTBOX_SECRET = 'outbox body must stay private'

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
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

interface RequestOptions {
  method?: string
  host?: string
  /** `null` sends no credentials; `undefined` uses TOKEN. */
  token?: string | null
  cookie?: string
}

function request(url: string, options: RequestOptions = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = {}
    if (options.host) headers.host = options.host
    const token = options.token === undefined ? TOKEN : options.token
    if (token !== null) headers.authorization = `Bearer ${token}`
    if (options.cookie) headers.cookie = options.cookie
    const req = http.request(url, { method: options.method ?? 'GET', headers }, res => {
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
  res: http.IncomingMessage
  headers: http.IncomingHttpHeaders
  frame: string
}

function openSse(
  url: string,
  options: { token?: string | null; cookie?: string } = {},
): Promise<SseFrame> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = {}
    const token = options.token === undefined ? TOKEN : options.token
    if (token !== null) headers.authorization = `Bearer ${token}`
    if (options.cookie) headers.cookie = options.cookie
    const req = http.get(url, { headers }, res => {
      let buffer = ''
      res.setEncoding('utf8')
      const onData = (chunk: string): void => {
        buffer += chunk
        const end = buffer.indexOf('\n\n')
        if (end >= 0) {
          res.off('data', onData)
          resolve({ req, res, headers: res.headers, frame: buffer.slice(0, end) })
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
  store.putDoc('ticket', 'tkt_ui_spec', {
    ...ticket,
    id: 'tkt_ui_spec',
    title: 'speculative ticket must stay hidden',
    speculative: true,
    originTriggerId: 'trg_ui_spec',
  } satisfies Ticket)
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
    text: OUTBOX_SECRET,
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
  const server = await startUiServer({ home, store, metrics, token: TOKEN, port: 0 })
  cleanup.push(async () => {
    await server.close()
    if (store.isOpen) store.close()
    fs.rmSync(home, { recursive: true, force: true })
  })
  return { home, store, metrics, server, base: server.url }
}

describe('local UI server', () => {
  it('renders escaped HTML with no external assets or message bodies', async () => {
    const { base } = await startSeeded()
    const logs: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
    const response = await request(`${base}/`)
    log.mockRestore()

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
    expect(response.body).toContain('im:thread-1')
    expect(response.body).not.toContain(OUTBOX_SECRET)
    expect(response.body).not.toContain('tkt_ui_spec')
    expect(response.body).not.toContain(TOKEN)
    expect(response.body).not.toContain('http://')
    expect(response.body).not.toContain('https://')
    expect(logs.join('\n')).not.toContain(TOKEN)
  })

  it('serves the same read model through /api/snapshot without bodies or speculation', async () => {
    const { base, home } = await startSeeded()
    const response = await request(`${base}/api/snapshot`)

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    const snapshot = JSON.parse(response.body) as {
      tickets: { id: string; title: string; stage: string; ended: boolean; paused: boolean; createdAt: string }[]
      threads: { key: string; subscriptions: string[]; pending: number; deferred: boolean }[]
      outbox: { id: string; status: string; channel: string; thread: string; ticketId: string }[]
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
      ticketId: 'tkt_ui_1',
    })
    expect(snapshot.outbox[0]).not.toHaveProperty('text')

    expect(snapshot.health.store).toBe('ok')
    expect(snapshot.health.vaultMode).toBe('absent')
    expect(snapshot.health.watchdogIdle).toBe(true)
    expect(snapshot.metrics.counters['ingress.admit']).toBe(2)
    expect(snapshot.events).toHaveLength(1)
    expect(snapshot.events[0]?.kind).toBe('ticket.created')
    expect(snapshot.events[0]?.payload).toMatchObject({ ticketId: 'tkt_ui_1' })

    expect(response.body).not.toContain(OUTBOX_SECRET)
    expect(response.body).not.toContain('tkt_ui_spec')
    expect(response.body).not.toContain(TOKEN)
    // The home path is not part of the public snapshot.
    expect(JSON.stringify(snapshot)).not.toContain(home)
  })

  it('requires a token on every route except GET /health', async () => {
    const { base, store } = await startSeeded()

    for (const pathname of ['/', '/api/snapshot', '/api/events', '/nope']) {
      const missing = await request(`${base}${pathname}`, { token: null })
      expect(missing.status).toBe(401)
      expect(missing.body).toBe('unauthorized\n')
      expect(missing.body).not.toContain(TOKEN)

      const wrong = await request(`${base}${pathname}`, { token: OTHER_TOKEN })
      expect(wrong.status).toBe(401)
      expect(wrong.body).toBe('unauthorized\n')
      expect(wrong.body).not.toContain(TOKEN)
    }

    const health = await request(`${base}/health`, { token: null })
    expect(health.status).toBe(200)
    expect(health.body).toBe('{"ok":true}')
    expect(String(health.headers['content-type'])).toContain('application/json')
    expect(health.headers['cache-control']).toBe('no-store')
    expect(health.headers['x-content-type-options']).toBe('nosniff')

    // /health never reads state: it still answers with the Store closed.
    store.close()
    const closedHealth = await request(`${base}/health`, { token: null })
    expect(closedHealth.status).toBe(200)
    expect(closedHealth.body).toBe('{"ok":true}')
  })

  it('bootstraps a browser cookie from GET /?token= and redirects to a clean /', async () => {
    const { base } = await startSeeded()

    const boot = await request(`${base}/?token=${encodeURIComponent(TOKEN)}`, { token: null })
    expect(boot.status).toBe(303)
    expect(boot.headers.location).toBe('/')
    expect(String(boot.headers['cache-control'])).toBe('no-store')
    const setCookie = boot.headers['set-cookie']
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie
    expect(cookieHeader).toBeDefined()
    expect(cookieHeader).toContain('ds_ui_token=')
    expect(cookieHeader).toContain('HttpOnly')
    expect(cookieHeader).toContain('SameSite=Strict')
    expect(cookieHeader).toContain('Path=/')
    expect(String(cookieHeader)).not.toBe('')

    const cookiePair = String(cookieHeader).split(';')[0]!
    const page = await request(`${base}/`, { token: null, cookie: cookiePair })
    expect(page.status).toBe(200)
    expect(page.body).toContain('tkt_ui_1')
    expect(page.body).not.toContain(TOKEN)

    const snapshot = await request(`${base}/api/snapshot`, { token: null, cookie: cookiePair })
    expect(snapshot.status).toBe(200)
    expect(snapshot.body).toContain('tkt_ui_1')

    const sse = await openSse(`${base}/api/events`, { token: null, cookie: cookiePair })
    expect(sse.frame.startsWith('data: ')).toBe(true)
    sse.req.destroy()

    const bad = await request(`${base}/?token=${encodeURIComponent(OTHER_TOKEN)}`, { token: null })
    expect(bad.status).toBe(401)
    expect(bad.body).toBe('unauthorized\n')
    expect(bad.headers['set-cookie']).toBeUndefined()
  })

  it('rejects unknown paths and non-GET methods after authentication', async () => {
    const { base } = await startSeeded()

    const unauthMissing = await request(`${base}/nope`, { token: null })
    expect(unauthMissing.status).toBe(401)

    const missing = await request(`${base}/nope`)
    expect(missing.status).toBe(404)
    expect(missing.headers['cache-control']).toBe('no-store')
    expect(missing.headers['x-content-type-options']).toBe('nosniff')

    const unauthPost = await request(`${base}/`, { method: 'POST', token: null })
    expect(unauthPost.status).toBe(401)

    const post = await request(`${base}/`, { method: 'POST' })
    expect(post.status).toBe(405)
    expect(post.headers.allow).toBe('GET')
    expect(post.headers['cache-control']).toBe('no-store')
    expect(post.headers['x-content-type-options']).toBe('nosniff')
  })

  it('rejects non-loopback or malformed Host headers', async () => {
    const { base } = await startSeeded()

    for (const host of ['evil.example', '[::1]evil', '[::1]:80x', '127.0.0.1:notaport', 'localhost:80:90']) {
      const response = await request(`${base}/`, { host })
      expect(response.status, host).toBe(403)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['x-content-type-options']).toBe('nosniff')
      expect(response.body).toContain('forbidden')
    }

    for (const host of ['[::1]:4318', '[::1]', '127.0.0.1:4318', 'localhost:4318']) {
      const response = await request(`${base}/`, { host })
      expect(response.status, host).toBe(200)
    }
  })

  it('streams one snapshot frame over SSE and aborts cleanly', async () => {
    const { base } = await startSeeded()
    const sse = await openSse(`${base}/api/events`)

    expect(sse.headers['content-type']).toContain('text/event-stream')
    expect(sse.headers['cache-control']).toBe('no-store')
    expect(sse.headers['x-content-type-options']).toBe('nosniff')
    expect(sse.frame.startsWith('data: ')).toBe(true)
    expect(sse.frame).not.toContain(TOKEN)
    const snapshot = JSON.parse(sse.frame.slice('data: '.length)) as {
      tickets: { id: string }[]
      outbox: Record<string, unknown>[]
    }
    expect(snapshot.tickets[0]?.id).toBe('tkt_ui_1')
    expect(snapshot.outbox[0]).not.toHaveProperty('text')
    expect(sse.frame).not.toContain(OUTBOX_SECRET)

    // Client close must not leave the timer or response behind.
    sse.req.destroy()
    await new Promise(resolve => setTimeout(resolve, 25))
  })

  it('closes the SSE stream when the read model throws', async () => {
    const home = tempHome()
    const store = new Store(home)
    const metrics = new Metrics(home)
    const server = await startUiServer({ home, store, metrics, token: TOKEN, port: 0, eventIntervalMs: 20 })
    cleanup.push(async () => {
      await server.close()
      if (store.isOpen) store.close()
      fs.rmSync(home, { recursive: true, force: true })
    })

    const sse = await openSse(`${server.url}/api/events`)
    const closed = new Promise<void>((resolve, reject) => {
      sse.res.once('end', () => resolve())
      sse.res.once('error', reject)
      sse.res.resume()
    })
    // A closed Store makes buildSnapshot() throw on the next interval tick.
    store.close()
    await expect(Promise.race([
      closed,
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('SSE stream stayed open')), 2_000)
      }),
    ])).resolves.toBeUndefined()
  })

  it('fails closed without a long-enough token', async () => {
    const home = tempHome()
    const store = new Store(home)
    const metrics = new Metrics(home)
    cleanup.push(() => {
      if (store.isOpen) store.close()
      fs.rmSync(home, { recursive: true, force: true })
    })

    vi.stubEnv('DS_AGENT_UI_TOKEN', '')
    await expect(runUi(home, { token: '' })).rejects.toThrow(/requires a token/)
    await expect(runUi(home, { token: 'short-token' })).rejects.toThrow(/at least 16/)
    await expect(
      startUiServer({ home, store, metrics, token: 'short-token', port: 0 }),
    ).rejects.toThrow(/at least 16/)
  })

  it('refuses to bind anything but loopback', async () => {
    const home = tempHome()
    const store = new Store(home)
    const metrics = new Metrics(home)
    cleanup.push(() => {
      if (store.isOpen) store.close()
      fs.rmSync(home, { recursive: true, force: true })
    })
    await expect(runUi(home, { host: '0.0.0.0', token: TOKEN })).rejects.toThrow(/only binds loopback/)
    await expect(
      startUiServer({ home, store, metrics, host: '0.0.0.0', token: TOKEN, port: 0 }),
    ).rejects.toThrow(/non-loopback/)
  })

  it('never logs the token and shuts down on SIGTERM', async () => {
    const home = tempHome()
    cleanup.push(() => { fs.rmSync(home, { recursive: true, force: true }) })
    const entry = new URL('../src/cli/ui.ts', import.meta.url).href
    const script = `import { runUi } from ${JSON.stringify(entry)}; await runUi(process.env.DS_AGENT_UI_HOME, { port: 0 })`
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, DS_AGENT_UI_TOKEN: TOKEN, DS_AGENT_UI_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`runUi did not start: ${stderr}`))
      }, 10_000)
      child.stdout.on('data', chunk => {
        stdout += chunk
        if (stdout.includes('listening on')) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.once('exit', code => {
        clearTimeout(timer)
        reject(new Error(`runUi exited ${code}: ${stderr}`))
      })
    })

    child.kill('SIGTERM')
    await new Promise<void>(resolve => { child.once('exit', () => resolve()) })
    expect(stdout).toContain('listening on')
    expect(stdout).not.toContain(TOKEN)
    expect(stderr).not.toContain(TOKEN)
  })
})

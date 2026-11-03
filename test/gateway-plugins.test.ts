import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startGatewayServer, type GatewayHandle } from '../src/gateway/server.ts'
import { PluginHost } from '../src/gateway/plugins.ts'
import { maskingPlugin } from '../src/gateway/mask.ts'
import type { GatewayProvider } from '../src/gateway/config.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { reject(new Error('no address')); return }
      resolve(address.port)
    })
  })
}

interface FakeCall {
  path: string
  body: Record<string, unknown>
}

async function startFakeUpstream(): Promise<{ port: number; calls: FakeCall[] }> {
  const calls: FakeCall[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += String(chunk) })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      calls.push({ path: req.url ?? '/', body })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'fake',
        choices: [{ message: { role: 'assistant', content: `ok:${String(body.model)}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }))
    })
  })
  const port = await listen(server)
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  return { port, calls }
}

function provider(over: Partial<GatewayProvider> & { baseUrl: string }): GatewayProvider {
  return { id: 'fake', apiKey: 'k', ...over }
}

async function startGateway(
  providers: GatewayProvider[],
  token = 'tok',
  extra: { masking?: boolean; home?: string } = {},
): Promise<GatewayHandle> {
  const handle = await startGatewayServer({ host: '127.0.0.1', port: 0, token, providers, ...extra })
  cleanup.push(() => handle.close())
  return handle
}

function post(url: string, token: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('gateway plugins', () => {
  it('masking plugin masks on request and restores on response', async () => {
    const plugin = maskingPlugin()
    const state: Record<string, unknown> = {}
    const masked = await plugin.onRequest!(
      { messages: [{ role: 'user', content: 'key sk-abcdef123456 and a@b.com' }] },
      { protocol: 'chat', options: {}, state },
    ) as { messages: { content: string }[] }
    expect(masked.messages[0]!.content).not.toContain('sk-abcdef123456')
    expect(masked.messages[0]!.content).toContain('{{API_KEY_')
    const restored = await plugin.onResponse!(
      masked,
      { protocol: 'chat', options: {}, state },
    ) as { messages: { content: string }[] }
    expect(restored.messages[0]!.content).toContain('sk-abcdef123456')
  })

  it('loads plugin modules from a directory and exposes their strategies', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-plug-'))
    cleanup.push(async () => { fs.rmSync(dir, { recursive: true, force: true }) })
    fs.writeFileSync(
      path.join(dir, 'demo.mjs'),
      'export default { id: "demo", onRequest(body){ return { ...body, demo: true } }, strategies: { reverse: (seats) => seats.map(s => s.index).reverse() } }\n',
    )
    const host = new PluginHost()
    const loaded = await host.loadFromDir(dir)
    expect(loaded).toContain('demo')
    const body = await host.runRequest({ a: 1 }, { protocol: 'chat' }, {}) as { demo?: boolean }
    expect(body.demo).toBe(true)
    const order = host.strategies().reverse!(
      [{ index: 0, provider: 'a', model: 'm', priority: 0, cooling: false }, { index: 1, provider: 'b', model: 'm', priority: 0, cooling: false }],
      {},
    )
    expect(order).toEqual([1, 0])
  })

  it('translates Gemini generateContent to chat and back', async () => {
    const upstream = await startFakeUpstream()
    const gw = await startGateway([provider({ baseUrl: `http://127.0.0.1:${upstream.port}`, models: ['m1'] })])
    const res = await post(`${gw.url}/v1beta/models/m1:generateContent`, 'tok', {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    })
    expect(res.status).toBe(200)
    const json = await res.json() as { candidates: { content: { parts: { text: string }[] } }[] }
    expect(json.candidates[0]!.content.parts[0]!.text).toBe('ok:m1')
    expect(upstream.calls[0]!.path).toMatch(/\/chat\/completions$/)
    expect((upstream.calls[0]!.body as { messages: { content: string }[] }).messages[0]!.content).toBe('hi')
  })

  it('masks a chat request before it leaves the machine, end to end', async () => {
    const upstream = await startFakeUpstream()
    const gw = await startGateway([provider({ baseUrl: `http://127.0.0.1:${upstream.port}`, models: ['m1'] })], 'tok', { masking: true })
    await post(`${gw.url}/v1/chat/completions`, 'tok', { model: 'm1', messages: [{ role: 'user', content: 'token sk-abcdef123456' }] })
    const sent = (upstream.calls[0]!.body as { messages: { content: string }[] }).messages[0]!.content
    expect(sent).not.toContain('sk-abcdef123456')
    expect(sent).toContain('{{API_KEY_')
  })

  it('routes by a plugin strategy selected with X-Gateway-Routing', async () => {
    const upstream = await startFakeUpstream()
    const dead = createServer()
    const deadPort = await listen(dead)
    await new Promise<void>(resolve => dead.close(() => resolve()))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'))
    cleanup.push(async () => { fs.rmSync(home, { recursive: true, force: true }) })
    const plugDir = path.join(home, 'gateway-plugins')
    fs.mkdirSync(plugDir, { recursive: true })
    fs.writeFileSync(path.join(plugDir, 'rev.mjs'), 'export default { id: "rev", strategies: { reverse: (seats) => seats.map(s => s.index).reverse() } }\n')
    const gw = await startGateway([
      provider({ id: 'dead', baseUrl: `http://127.0.0.1:${deadPort}`, models: ['m1'], priority: 10 }),
      provider({ id: 'live', baseUrl: `http://127.0.0.1:${upstream.port}`, models: ['m1'], priority: 1 }),
    ], 'tok', { home })
    const res = await post(`${gw.url}/v1/chat/completions`, 'tok', { model: 'm1', messages: [{ role: 'user', content: 'hi' }] }, { 'x-gateway-routing': 'reverse' })
    expect(res.status).toBe(200)
    const snapshot = gw.metrics.snapshot()
    expect(snapshot.byProvider.live?.requests).toBe(1)
    expect(snapshot.byProvider.dead).toBeUndefined()
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startGatewayServer, type GatewayHandle } from '../src/gateway/server.ts'
import { GatewayRouter } from '../src/gateway/router.ts'
import { gatewayTokenPath, loadOrCreateGatewayToken, readGatewayToken } from '../src/gateway/token.ts'
import { gatewayProvidersFromEnv, type GatewayProvider } from '../src/gateway/config.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('no address'))
        return
      }
      resolve(address.port)
    })
  })
}

interface FakeUpstream {
  port: number
  calls: { path: string; auth?: string; body: Record<string, unknown> }[]
}

async function startFakeUpstream(): Promise<FakeUpstream> {
  const calls: FakeUpstream['calls'] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += String(chunk) })
    req.on('end', () => {
      const urlPath = req.url ?? '/'
      if (req.method === 'GET' && urlPath.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model' }] }))
        return
      }
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      calls.push({ path: urlPath, auth: req.headers.authorization, body })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'fake',
        choices: [{ message: { role: 'assistant', content: `ok:${String(body.model)}` } }],
        usage: { total_tokens: 7 },
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

async function startGateway(providers: GatewayProvider[], token = 'tok'): Promise<GatewayHandle> {
  const handle = await startGatewayServer({ host: '127.0.0.1', port: 0, token, providers })
  cleanup.push(() => handle.close())
  return handle
}

describe('gateway server', () => {
  it('requires the bearer token and proxies chat to the provider', async () => {
    const upstream = await startFakeUpstream()
    const gw = await startGateway([provider({ baseUrl: `http://127.0.0.1:${upstream.port}`, models: ['m1'] })], 'secret')

    const unauth = await fetch(`${gw.url}/v1/models`)
    expect(unauth.status).toBe(401)

    const models = await fetch(`${gw.url}/v1/models`, { headers: { authorization: 'Bearer secret' } })
    expect(models.status).toBe(200)
    const list = await models.json() as { data: { id: string }[] }
    expect(list.data.map(model => model.id)).toContain('m1')

    const chat = await fetch(`${gw.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(chat.status).toBe(200)
    const json = await chat.json() as { choices: { message: { content: string } }[] }
    expect(json.choices[0]!.message.content).toBe('ok:m1')
    expect(upstream.calls).toHaveLength(1)
    expect(upstream.calls[0]!.auth).toBe('Bearer k')
    expect(upstream.calls[0]!.body.model).toBe('m1')
    expect(gw.metrics.snapshot().byProvider.fake).toMatchObject({ requests: 1, errors: 0, tokens: 7 })
  })

  it('serves /health without auth', async () => {
    const upstream = await startFakeUpstream()
    const gw = await startGateway([provider({ baseUrl: `http://127.0.0.1:${upstream.port}`, models: ['m1'] })])
    const health = await fetch(`${gw.url}/health`)
    expect(health.status).toBe(200)
    const body = await health.json() as { ok: boolean; providers: { id: string }[] }
    expect(body.ok).toBe(true)
    expect(body.providers.map(item => item.id)).toEqual(['fake'])
  })

  it('falls back to a healthy provider when the top provider is down', async () => {
    const dead = createServer()
    const deadPort = await listen(dead)
    await new Promise<void>(resolve => dead.close(() => resolve()))
    const upstream = await startFakeUpstream()
    const gw = await startGateway([
      provider({ id: 'dead', baseUrl: `http://127.0.0.1:${deadPort}`, models: ['m1'], priority: 10 }),
      provider({ id: 'live', baseUrl: `http://127.0.0.1:${upstream.port}`, models: ['m1'], priority: 1 }),
    ])
    const chat = await fetch(`${gw.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(chat.status).toBe(200)
    const json = await chat.json() as { choices: { message: { content: string } }[] }
    expect(json.choices[0]!.message.content).toBe('ok:m1')
    expect(upstream.calls).toHaveLength(1)
    const snapshot = gw.metrics.snapshot()
    expect(snapshot.byProvider.dead?.errors).toBe(1)
    expect(snapshot.byProvider.live?.requests).toBe(1)
  })
})

describe('GatewayRouter', () => {
  it('orders by priority, honors provider/model prefix, and cools down failures', () => {
    let now = 1_000
    const router = new GatewayRouter([
      { id: 'a', baseUrl: 'http://a', apiKey: '', models: ['m1'], priority: 5 },
      { id: 'b', baseUrl: 'http://b', apiKey: '', models: ['m1'], priority: 1 },
      { id: 'c', baseUrl: 'http://c', apiKey: '', models: ['m2'], priority: 9 },
    ], 'm1', () => now)
    expect(router.candidates('m1').map(candidate => candidate.provider.id)).toEqual(['a', 'b'])
    expect(router.candidates('c/m9')[0]).toMatchObject({ model: 'm9' })
    expect(router.candidates('m2').map(candidate => candidate.provider.id)).toEqual(['c'])
    router.recordFailure('a')
    expect(router.candidates('m1').map(candidate => candidate.provider.id)).toEqual(['b', 'a'])
    now += 31_000
    expect(router.candidates('m1').map(candidate => candidate.provider.id)).toEqual(['a', 'b'])
  })
})

describe('gateway token', () => {
  it('persists a 0600 token and reuses it', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'))
    cleanup.push(async () => { fs.rmSync(home, { recursive: true, force: true }) })
    const first = loadOrCreateGatewayToken(home)
    expect(first).toMatch(/^gw_[0-9a-f]+$/)
    expect(readGatewayToken(home)).toBe(first)
    expect(loadOrCreateGatewayToken(home)).toBe(first)
    expect(fs.statSync(gatewayTokenPath(home)).mode & 0o777).toBe(0o600)
  })

  it('honors an explicit override without writing a token file', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'))
    cleanup.push(async () => { fs.rmSync(home, { recursive: true, force: true }) })
    expect(loadOrCreateGatewayToken(home, 'explicit')).toBe('explicit')
    expect(fs.existsSync(gatewayTokenPath(home))).toBe(false)
  })
})

describe('gatewayProvidersFromEnv', () => {
  it('parses JSON providers and resolves apiKeyEnv', () => {
    const env = {
      DS_AGENT_GATEWAY_PROVIDERS: JSON.stringify([
        { id: 'd', baseUrl: 'http://x', apiKeyEnv: 'MY_KEY', models: ['m'] },
      ]),
      MY_KEY: 'secret',
    } as NodeJS.ProcessEnv
    expect(gatewayProvidersFromEnv(env)[0]).toMatchObject({ id: 'd', baseUrl: 'http://x', apiKey: 'secret', models: ['m'] })
  })

  it('falls back to a single BYOM provider', () => {
    const env = {
      DS_AGENT_API_BASE: 'http://y',
      DS_AGENT_API_KEY: 'k',
      DS_AGENT_API_MODEL: 'm2',
    } as NodeJS.ProcessEnv
    expect(gatewayProvidersFromEnv(env)).toEqual([
      { id: 'default', baseUrl: 'http://y', apiKey: 'k', priority: 0, models: ['m2'] },
    ])
  })

  it('is empty with no configuration', () => {
    expect(gatewayProvidersFromEnv({} as NodeJS.ProcessEnv)).toEqual([])
  })
})

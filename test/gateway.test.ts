import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bearerAuthorized, startGatewayServer, type GatewayHandle } from '../src/gateway/server.ts'
import { GatewayRouter } from '../src/gateway/router.ts'
import {
  GatewayTokenFileError,
  GatewayTokenPermissionError,
  gatewayTokenPath,
  loadOrCreateGatewayToken,
  readGatewayToken,
} from '../src/gateway/token.ts'
import { gatewayAliasesFromEnv, gatewayProvidersFromEnv, type GatewayProvider } from '../src/gateway/config.ts'
import { gatewayHostWarning, runGatewayCommand } from '../src/cli/gateway.ts'

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

interface FakeCall {
  path: string
  method: string
  auth?: string
  xApiKey?: string
  body: Record<string, unknown>
}

interface FakeUpstream {
  port: number
  calls: FakeCall[]
}

async function startFakeUpstream(): Promise<FakeUpstream> {
  const calls: FakeCall[] = []
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
      calls.push({
        path: urlPath,
        method: req.method ?? '',
        auth: req.headers.authorization,
        xApiKey: typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined,
        body,
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      if (urlPath.endsWith('/embeddings')) {
        res.end(JSON.stringify({ object: 'list', data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }], usage: { total_tokens: 3 } }))
        return
      }
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
  aliases?: Record<string, string[]>,
): Promise<GatewayHandle> {
  const handle = await startGatewayServer({ host: '127.0.0.1', port: 0, token, providers, ...(aliases ? { aliases } : {}) })
  cleanup.push(() => handle.close())
  return handle
}

function post(url: string, token: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('gateway server', () => {
  it('requires the bearer token and proxies chat to the provider', async () => {
    const upstream = await startFakeUpstream()
    const gw = await startGateway([provider({ baseUrl: `http://127.0.0.1:${upstream.port}`, models: ['m1'] })], 'secret')

    expect((await fetch(`${gw.url}/v1/models`)).status).toBe(401)

    const models = await fetch(`${gw.url}/v1/models`, { headers: { authorization: 'Bearer secret' } })
    expect(models.status).toBe(200)
    const list = await models.json() as { data: { id: string }[] }
    expect(list.data.map(model => model.id)).toContain('m1')

    const chat = await post(`${gw.url}/v1/chat/completions`, 'secret', { model: 'm1', messages: [{ role: 'user', content: 'hi' }] })
    expect(chat.status).toBe(200)
    const json = await chat.json() as { choices: { message: { content: string } }[] }
    expect(json.choices[0]!.message.content).toBe('ok:m1')
    expect(upstream.calls[0]!.auth).toBe('Bearer k')
    expect(upstream.calls[0]!.body.model).toBe('m1')
    expect(gw.metrics.snapshot().byProvider.fake).toMatchObject({ requests: 1, errors: 0, tokens: 7 })
  })

  it('rejects missing, malformed, and wrong bearer tokens with one uniform 401', async () => {
    const upstream = await startFakeUpstream()
    const gw = await startGateway([provider({ baseUrl: `http://127.0.0.1:${upstream.port}`, models: ['m1'] })], 'secret')
    const body = { model: 'm1', messages: [{ role: 'user', content: 'hi' }] }
    const postJson = (headers: Record<string, string>): Promise<Response> => fetch(`${gw.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    const responses = [
      await postJson({}),
      await postJson({ authorization: 'Basic abc' }),
      await postJson({ authorization: 'Bearer' }),
      await postJson({ authorization: 'Bearer wrong' }),
      await postJson({ authorization: 'Bearer secret-extra' }),
      await postJson({ authorization: `Bearer ${'x'.repeat(4096)}` }),
    ]
    const bodies: string[] = []
    for (const response of responses) {
      expect(response.status).toBe(401)
      bodies.push(await response.text())
    }
    expect(new Set(bodies)).toEqual(new Set([JSON.stringify({ error: { message: 'invalid gateway token' } })]))
    expect(upstream.calls).toHaveLength(0)
  })

  it('sets nosniff and no-store on SSE responses', async () => {
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
        res.end('data: [DONE]\n\n')
      })
    })
    const port = await listen(server)
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const gw = await startGateway([provider({ baseUrl: `http://127.0.0.1:${port}`, models: ['m1'] })])

    const stream = await post(`${gw.url}/v1/chat/completions`, 'tok', {
      model: 'm1',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(stream.status).toBe(200)
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    expect(stream.headers.get('x-content-type-options')).toBe('nosniff')
    expect(stream.headers.get('cache-control')).toBe('no-store')
    expect(await stream.text()).toContain('data: [DONE]')
  })

  it('sets nosniff on every response and no-store on authenticated responses', async () => {
    const upstream = await startFakeUpstream()
    const gw = await startGateway([provider({ baseUrl: `http://127.0.0.1:${upstream.port}`, models: ['m1'] })])

    const health = await fetch(`${gw.url}/health`)
    expect(health.status).toBe(200)
    expect(health.headers.get('x-content-type-options')).toBe('nosniff')
    expect(health.headers.get('cache-control')).toBeNull()

    const denied = await fetch(`${gw.url}/v1/models`)
    expect(denied.status).toBe(401)
    expect(denied.headers.get('x-content-type-options')).toBe('nosniff')

    const models = await fetch(`${gw.url}/v1/models`, { headers: { authorization: 'Bearer tok' } })
    expect(models.status).toBe(200)
    expect(models.headers.get('x-content-type-options')).toBe('nosniff')
    expect(models.headers.get('cache-control')).toBe('no-store')

    const chat = await post(`${gw.url}/v1/chat/completions`, 'tok', { model: 'm1', messages: [{ role: 'user', content: 'hi' }] })
    expect(chat.headers.get('x-content-type-options')).toBe('nosniff')
    expect(chat.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses to start when the bearer token is empty', async () => {
    for (const token of ['', '   ']) {
      const starting = startGatewayServer({ host: '127.0.0.1', port: 0, token, providers: [] })
      // Keeps a failed RED run from leaving a listening server behind.
      starting.then(handle => handle.close()).catch(() => undefined)
      await expect(starting).rejects.toThrow(/token must not be empty/i)
    }
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
    const chat = await post(`${gw.url}/v1/chat/completions`, 'tok', { model: 'm1', messages: [{ role: 'user', content: 'hi' }] })
    expect(chat.status).toBe(200)
    const json = await chat.json() as { choices: { message: { content: string } }[] }
    expect(json.choices[0]!.message.content).toBe('ok:m1')
    const snapshot = gw.metrics.snapshot()
    expect(snapshot.byProvider.dead?.errors).toBe(1)
    expect(snapshot.byProvider.live?.requests).toBe(1)
  })

  it('proxies embeddings to the provider /embeddings path', async () => {
    const upstream = await startFakeUpstream()
    const gw = await startGateway([provider({ baseUrl: `http://127.0.0.1:${upstream.port}`, models: ['m1'] })])
    const res = await post(`${gw.url}/v1/embeddings`, 'tok', { model: 'm1', input: 'hello' })
    expect(res.status).toBe(200)
    const json = await res.json() as { data: { embedding: number[] }[] }
    expect(json.data[0]!.embedding).toEqual([0.1, 0.2])
    expect(upstream.calls[0]!.path).toMatch(/\/embeddings$/)
    expect(upstream.calls[0]!.body.model).toBe('m1')
  })

  it('translates Anthropic /v1/messages to a chat call and back', async () => {
    const upstream = await startFakeUpstream()
    const gw = await startGateway([provider({ baseUrl: `http://127.0.0.1:${upstream.port}`, models: ['m1'] })])
    const res = await post(`${gw.url}/v1/messages`, 'tok', {
      model: 'm1',
      max_tokens: 64,
      system: 'be brief',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    expect(res.status).toBe(200)
    const json = await res.json() as { type: string; role: string; content: { type: string; text: string }[] }
    expect(json.type).toBe('message')
    expect(json.role).toBe('assistant')
    expect(json.content[0]).toEqual({ type: 'text', text: 'ok:m1' })
    const sent = upstream.calls[0]!.body as { messages: { role: string; content: string }[]; max_tokens: number }
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'be brief' })
    expect(sent.messages[1]).toEqual({ role: 'user', content: 'hi' })
    expect(sent.max_tokens).toBe(64)
  })

  it('exposes usage via /v1/gateway/quotas', async () => {
    const upstream = await startFakeUpstream()
    const gw = await startGateway([provider({ baseUrl: `http://127.0.0.1:${upstream.port}`, models: ['m1'] })])
    await post(`${gw.url}/v1/chat/completions`, 'tok', { model: 'm1', messages: [{ role: 'user', content: 'hi' }] })
    const res = await fetch(`${gw.url}/v1/gateway/quotas`, { headers: { authorization: 'Bearer tok' } })
    expect(res.status).toBe(200)
    const json = await res.json() as { object: string; metrics: { requests: number } }
    expect(json.object).toBe('gateway.quotas')
    expect(json.metrics.requests).toBe(1)
  })

  it('sends x-api-key credentials when auth=x-api-key', async () => {
    const upstream = await startFakeUpstream()
    const gw = await startGateway([provider({ baseUrl: `http://127.0.0.1:${upstream.port}`, models: ['m1'], apiKey: 'secret', auth: 'x-api-key' })])
    await post(`${gw.url}/v1/chat/completions`, 'tok', { model: 'm1', messages: [{ role: 'user', content: 'hi' }] })
    expect(upstream.calls[0]!.xApiKey).toBe('secret')
    expect(upstream.calls[0]!.auth).toBeUndefined()
  })

  it('rotates multiple api keys round-robin', async () => {
    const upstream = await startFakeUpstream()
    const gw = await startGateway([provider({ baseUrl: `http://127.0.0.1:${upstream.port}`, models: ['m1'], apiKey: '', apiKeys: ['k1', 'k2'] })])
    await post(`${gw.url}/v1/chat/completions`, 'tok', { model: 'm1', messages: [{ role: 'user', content: 'one' }] })
    await post(`${gw.url}/v1/chat/completions`, 'tok', { model: 'm1', messages: [{ role: 'user', content: 'two' }] })
    expect(upstream.calls.map(call => call.auth)).toEqual(['Bearer k1', 'Bearer k2'])
  })

  it('routes a model alias through its ordered candidates', async () => {
    const upstream = await startFakeUpstream()
    const gw = await startGateway(
      [provider({ id: 'a', baseUrl: `http://127.0.0.1:${upstream.port}`, models: ['m1'] })],
      'tok',
      { auto: ['a/m1'] },
    )
    const res = await post(`${gw.url}/v1/chat/completions`, 'tok', { model: 'auto', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    const json = await res.json() as { choices: { message: { content: string } }[] }
    expect(json.choices[0]!.message.content).toBe('ok:m1')
    const models = await fetch(`${gw.url}/v1/models`, { headers: { authorization: 'Bearer tok' } })
    const list = await models.json() as { data: { id: string }[] }
    expect(list.data.map(item => item.id)).toContain('auto')
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

  it('expands a routing alias to its ordered candidates', () => {
    const router = new GatewayRouter([
      { id: 'a', baseUrl: 'http://a', apiKey: '', models: ['m1'], priority: 5 },
      { id: 'b', baseUrl: 'http://b', apiKey: '', models: ['m9'], priority: 1 },
    ], 'm1', () => 0, { auto: ['a/m1', 'b/m9'] })
    expect(router.candidates('auto').map(candidate => `${candidate.provider.id}/${candidate.model}`)).toEqual(['a/m1', 'b/m9'])
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

  const posixOnly = process.platform === 'win32' ? it.skip : it
  posixOnly('re-applies mode 0600 to an existing token file on read and reuse', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'))
    cleanup.push(async () => { fs.rmSync(home, { recursive: true, force: true }) })
    const token = loadOrCreateGatewayToken(home)
    const file = gatewayTokenPath(home)

    fs.chmodSync(file, 0o644)
    expect(fs.statSync(file).mode & 0o777).toBe(0o644)
    expect(readGatewayToken(home)).toBe(token)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)

    fs.chmodSync(file, 0o644)
    expect(loadOrCreateGatewayToken(home)).toBe(token)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  posixOnly('rejects a symlinked token file without reading or chmodding its target', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'))
    cleanup.push(async () => { fs.rmSync(home, { recursive: true, force: true }) })
    const target = path.join(home, 'redirected')
    fs.writeFileSync(target, 'redirected-token\n', { mode: 0o644 })
    fs.chmodSync(target, 0o644)
    fs.symlinkSync(target, gatewayTokenPath(home))

    expect(() => readGatewayToken(home)).toThrow(GatewayTokenFileError)
    expect(() => loadOrCreateGatewayToken(home)).toThrow(GatewayTokenFileError)
    expect(fs.statSync(target).mode & 0o777).toBe(0o644)
  })

  it('rejects a non-regular token path', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'))
    cleanup.push(async () => { fs.rmSync(home, { recursive: true, force: true }) })
    fs.mkdirSync(gatewayTokenPath(home))

    expect(() => readGatewayToken(home)).toThrow(GatewayTokenFileError)
    expect(() => readGatewayToken(home)).toThrow(/not a regular file/)
    expect(() => loadOrCreateGatewayToken(home)).toThrow(GatewayTokenFileError)
  })

  posixOnly('rejects a multiply-linked token file without chmodding the other name', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'))
    cleanup.push(async () => { fs.rmSync(home, { recursive: true, force: true }) })
    const target = path.join(home, 'shared')
    fs.writeFileSync(target, 'shared-token\n', { mode: 0o644 })
    fs.chmodSync(target, 0o644)
    fs.linkSync(target, gatewayTokenPath(home))

    expect(() => readGatewayToken(home)).toThrow(/multiple hard links/)
    expect(fs.statSync(target).mode & 0o777).toBe(0o644)
  })

  posixOnly('fails closed and never returns the token when 0600 cannot be applied', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'))
    cleanup.push(async () => { fs.rmSync(home, { recursive: true, force: true }) })
    const token = loadOrCreateGatewayToken(home)
    const file = gatewayTokenPath(home)
    fs.chmodSync(file, 0o644)
    const denied = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    const chmod = vi.spyOn(fs, 'fchmodSync').mockImplementation(() => { throw denied })
    try {
      let returned: string | undefined
      expect(() => { returned = readGatewayToken(home) }).toThrow(GatewayTokenPermissionError)
      expect(returned).toBeUndefined()
      expect(token).toMatch(/^gw_[0-9a-f]+$/)
    } finally {
      chmod.mockRestore()
    }
  })
})

describe('bearer authorization', () => {
  it('accepts RFC 7235 bearer scheme case and whitespace variants', () => {
    expect(bearerAuthorized('Bearer abc', 'abc')).toBe(true)
    expect(bearerAuthorized('bearer abc', 'abc')).toBe(true)
    expect(bearerAuthorized('BEARER abc', 'abc')).toBe(true)
    expect(bearerAuthorized('Bearer\tabc', 'abc')).toBe(true)
    expect(bearerAuthorized('Bearer   abc', 'abc')).toBe(true)
  })

  it('rejects missing or malformed credentials', () => {
    expect(bearerAuthorized(undefined, 'abc')).toBe(false)
    expect(bearerAuthorized('', 'abc')).toBe(false)
    expect(bearerAuthorized('Bearer abd', 'abc')).toBe(false)
    expect(bearerAuthorized('Bearer ab', 'abc')).toBe(false)
    expect(bearerAuthorized('Bearer abc ', 'abc')).toBe(false)
    expect(bearerAuthorized('Bearer', 'abc')).toBe(false)
    expect(bearerAuthorized('Token abc', 'abc')).toBe(false)
    expect(bearerAuthorized(['Bearer abc'], 'abc')).toBe(false)
  })
})

describe('gateway host exposure', () => {
  it('treats only loopback names as safe', () => {
    for (const host of ['127.0.0.1', '::1', '[::1]', 'localhost', 'LOCALHOST', ' 127.0.0.1 ']) {
      expect(gatewayHostWarning(host)).toBeUndefined()
    }
  })

  it('warns about the unauthenticated endpoints when binding beyond loopback', () => {
    const warning = gatewayHostWarning('0.0.0.0')
    expect(warning).toBeDefined()
    expect(warning).toContain('0.0.0.0')
    expect(warning).toMatch(/not a loopback/i)
    expect(warning).toContain('/health')
    expect(warning).toMatch(/unauthenticated/i)
    expect(gatewayHostWarning('192.168.0.10')).toBeDefined()
    expect(gatewayHostWarning('::')).toBeDefined()
  })
})

describe('gateway CLI', () => {
  it('runGatewayCommand emits the non-loopback warning before starting', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'))
    cleanup.push(async () => { fs.rmSync(home, { recursive: true, force: true }) })
    const originalArgv = process.argv
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('DS_AGENT_GATEWAY_PROVIDERS', '')
    vi.stubEnv('DS_AGENT_API_BASE', '')
    vi.stubEnv('DS_AGENT_API_KEY', '')
    vi.stubEnv('DS_AGENT_GATEWAY_TOKEN', '')
    process.argv = ['node', 'ds-agent', 'gateway', '--host', '0.0.0.0']
    try {
      await expect(runGatewayCommand(home)).rejects.toThrow(/no providers configured/)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toContain('not a loopback address')
    } finally {
      process.argv = originalArgv
      warn.mockRestore()
      vi.unstubAllEnvs()
    }
  })
})

describe('gateway config from env', () => {
  it('parses JSON providers and resolves apiKeyEnv', () => {
    const env = {
      DS_AGENT_GATEWAY_PROVIDERS: JSON.stringify([{ id: 'd', baseUrl: 'http://x', apiKeyEnv: 'MY_KEY', models: ['m'] }]),
      MY_KEY: 'secret',
    } as NodeJS.ProcessEnv
    expect(gatewayProvidersFromEnv(env)[0]).toMatchObject({ id: 'd', baseUrl: 'http://x', apiKey: 'secret', models: ['m'] })
  })

  it('resolves a preset by name and its key env', () => {
    const env = {
      DS_AGENT_GATEWAY_PROVIDERS: JSON.stringify([{ id: 'ds', preset: 'deepseek' }]),
      DEEPSEEK_API_KEY: 'k',
    } as NodeJS.ProcessEnv
    expect(gatewayProvidersFromEnv(env)[0]).toMatchObject({ id: 'ds', baseUrl: 'https://api.deepseek.com', apiKey: 'k', models: ['deepseek-flash'] })
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

  it('parses routing aliases', () => {
    const env = { DS_AGENT_GATEWAY_ALIASES: JSON.stringify({ auto: ['a/m1', 'b/m9'] }) } as NodeJS.ProcessEnv
    expect(gatewayAliasesFromEnv(env)).toEqual({ auto: ['a/m1', 'b/m9'] })
  })

  it('is empty with no configuration', () => {
    expect(gatewayProvidersFromEnv({} as NodeJS.ProcessEnv)).toEqual([])
    expect(gatewayAliasesFromEnv({} as NodeJS.ProcessEnv)).toEqual({})
  })
})

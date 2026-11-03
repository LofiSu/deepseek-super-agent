import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { startGatewayServer, type GatewayHandle } from '../src/gateway/server.ts'
import { GatewayLimits } from '../src/gateway/limits.ts'
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

async function startFakeUpstream(): Promise<number> {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += String(chunk) })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'fake',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }))
    })
  })
  const port = await listen(server)
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  return port
}

async function startGateway(providers: GatewayProvider[]): Promise<GatewayHandle> {
  const handle = await startGatewayServer({ host: '127.0.0.1', port: 0, token: 'tok', providers })
  cleanup.push(() => handle.close())
  return handle
}

function chat(url: string): Promise<Response> {
  return fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
  })
}

describe('gateway limits', () => {
  it('enforces RPM and answers 429 with Retry-After when saturated', async () => {
    const upstream = await startFakeUpstream()
    const gw = await startGateway([
      { id: 'p', baseUrl: `http://127.0.0.1:${upstream}`, apiKey: 'k', models: ['m1'], maxRpm: 1 },
    ])
    expect((await chat(gw.url)).status).toBe(200)
    const second = await chat(gw.url)
    expect(second.status).toBe(429)
    expect(second.headers.get('retry-after')).toBeTruthy()
  })

  it('rests a provider after its daily token budget is spent', async () => {
    const upstream = await startFakeUpstream()
    const gw = await startGateway([
      { id: 'p', baseUrl: `http://127.0.0.1:${upstream}`, apiKey: 'k', models: ['m1'], dailyTokens: 5 },
    ])
    expect((await chat(gw.url)).status).toBe(200)
    const second = await chat(gw.url)
    expect(second.status).toBe(429)
    const quotas = await fetch(`${gw.url}/v1/gateway/quotas`, { headers: { authorization: 'Bearer tok' } })
    const body = await quotas.json() as { limits: { id: string; exhausted: boolean; tokensToday: number }[] }
    expect(body.limits.find(item => item.id === 'p')).toMatchObject({ exhausted: true, tokensToday: 7 })
  })

  it('counts concurrency in the limiter unit', () => {
    const limits = new GatewayLimits(() => ({ maxConcurrency: 1 }))
    expect(limits.acquire('a')).toBe(true)
    expect(limits.acquire('a')).toBe(false)
    limits.release('a')
    expect(limits.acquire('a')).toBe(true)
  })
})

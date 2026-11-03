import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { strategyPlugin } from '../src/gateway/builtin-plugins.ts'
import type { RouteSeat } from '../src/gateway/plugins.ts'
import { startGatewayServer, type GatewayHandle } from '../src/gateway/server.ts'
import type { GatewayProvider } from '../src/gateway/config.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

const strategies = strategyPlugin().strategies!

function seats(rows: Array<Partial<RouteSeat> & { provider: string }>): RouteSeat[] {
  return rows.map((row, index) => ({ index, model: 'm', priority: 0, cooling: false, ...row }))
}

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
    req.on('data', () => undefined)
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { total_tokens: 1 } }))
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

function chat(url: string, routing: string): Promise<Response> {
  return fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json', 'x-gateway-routing': routing },
    body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
  })
}

describe('usage-driven strategies', () => {
  it('free orders by cost ascending', () => {
    expect(strategies.free!(seats([{ provider: 'a', cost: 0.5 }, { provider: 'b', cost: 0.1 }]), {})).toEqual([1, 0])
  })

  it('usage orders least-used first', () => {
    expect(strategies.usage!(seats([{ provider: 'a', requests: 10 }, { provider: 'b', requests: 2 }]), {})).toEqual([1, 0])
  })

  it('fast orders by average latency, unknown last', () => {
    expect(strategies.fast!(seats([{ provider: 'a', avgLatencyMs: 100 }, { provider: 'b', avgLatencyMs: 20 }]), {})).toEqual([1, 0])
    expect(strategies.fast!(seats([{ provider: 'a', avgLatencyMs: 100 }, { provider: 'b' }]), {})).toEqual([0, 1])
  })

  it('pace orders by remaining allowance headroom', () => {
    expect(strategies.pace!(seats([{ provider: 'a', tokensToday: 80, dailyTokens: 100 }, { provider: 'b', tokensToday: 10, dailyTokens: 100 }]), {})).toEqual([1, 0])
    expect(strategies.pace!(seats([{ provider: 'a', tokensToday: 50 }, { provider: 'b', tokensToday: 5 }]), {})).toEqual([1, 0])
  })

  it('routes by the free strategy end to end', async () => {
    const upstream = await startFakeUpstream()
    const gw = await startGateway([
      { id: 'expensive', baseUrl: `http://127.0.0.1:${upstream}`, apiKey: 'k', models: ['m1'], priority: 10, cost: 5 },
      { id: 'cheap', baseUrl: `http://127.0.0.1:${upstream}`, apiKey: 'k', models: ['m1'], priority: 1, cost: 1 },
    ])
    expect((await chat(gw.url, 'free')).status).toBe(200)
    const snapshot = gw.metrics.snapshot()
    expect(snapshot.byProvider.cheap?.requests).toBe(1)
    expect(snapshot.byProvider.expensive).toBeUndefined()
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { startGatewayServer, type GatewayHandle } from '../src/gateway/server.ts'
import { Affinity } from '../src/gateway/affinity.ts'
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

async function closedPort(): Promise<number> {
  const server = createServer()
  const port = await listen(server)
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

async function startGateway(providers: GatewayProvider[]): Promise<GatewayHandle> {
  const handle = await startGatewayServer({ host: '127.0.0.1', port: 0, token: 'tok', providers })
  cleanup.push(() => handle.close())
  return handle
}

function chat(url: string, session?: string): Promise<Response> {
  return fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer tok',
      'content-type': 'application/json',
      ...(session ? { 'x-gateway-session': session } : {}),
    },
    body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
  })
}

describe('gateway affinity', () => {
  it('keeps a session on the provider that answered it', async () => {
    const live = await startFakeUpstream()
    const dead = await closedPort()
    const gw = await startGateway([
      { id: 'dead', baseUrl: `http://127.0.0.1:${dead}`, apiKey: 'k', models: ['m1'], priority: 10 },
      { id: 'live', baseUrl: `http://127.0.0.1:${live}`, apiKey: 'k', models: ['m1'], priority: 1 },
    ])
    expect((await chat(gw.url, 's1')).status).toBe(200)
    expect((await chat(gw.url, 's1')).status).toBe(200)
    const snapshot = gw.metrics.snapshot()
    expect(snapshot.byProvider.dead?.errors).toBe(1)
    expect(snapshot.byProvider.live?.requests).toBe(2)

    const sessions = await fetch(`${gw.url}/v1/gateway/sessions`, { headers: { authorization: 'Bearer tok' } })
    const body = await sessions.json() as { sessions: { session: string; requests: number; tokens: number; providers: string[] }[] }
    const row = body.sessions.find(item => item.session === 's1')
    expect(row).toMatchObject({ requests: 3, tokens: 14 })
    expect(row!.providers).toContain('live')
  })

  it('bounds the affinity map', () => {
    const affinity = new Affinity(2)
    affinity.set('a', 'p1')
    affinity.set('b', 'p2')
    affinity.set('c', 'p3')
    expect(affinity.size()).toBe(2)
    expect(affinity.get('a')).toBeUndefined()
    expect(affinity.get('c')).toBe('p3')
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { startGatewayServer, type GatewayHandle } from '../src/gateway/server.ts'
import { PluginHost } from '../src/gateway/plugins.ts'
import { UsageLedger } from '../src/gateway/usage.ts'
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

describe('gateway usage ledger', () => {
  it('records a request and reports it at /v1/gateway/usage', async () => {
    const upstream = await startFakeUpstream()
    const gw = await startGateway([{ id: 'p', baseUrl: `http://127.0.0.1:${upstream}`, apiKey: 'k', models: ['m1'] }])
    const chat = await fetch(`${gw.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(chat.status).toBe(200)

    const res = await fetch(`${gw.url}/v1/gateway/usage`, { headers: { authorization: 'Bearer tok' } })
    expect(res.status).toBe(200)
    const body = await res.json() as {
      object: string
      summary: { requests: number; tokens: number; byProviderModel: { provider: string; model: string; requests: number; tokens: number }[] }
      recent: { provider: string; model: string; status: number; ok: boolean; tokens: number }[]
    }
    expect(body.object).toBe('gateway.usage')
    expect(body.summary.requests).toBe(1)
    expect(body.summary.tokens).toBe(7)
    expect(body.summary.byProviderModel[0]).toMatchObject({ provider: 'p', model: 'm1', requests: 1, tokens: 7 })
    expect(body.recent[0]).toMatchObject({ provider: 'p', model: 'm1', status: 200, ok: true, tokens: 7 })
  })

  it('fires the onUsage plugin hook', () => {
    const host = new PluginHost()
    const captured: Record<string, unknown>[] = []
    host.register({ id: 'u', onUsage(row) { captured.push(row) } })
    host.runUsage({ provider: 'p', tokens: 3 })
    expect(captured).toEqual([{ provider: 'p', tokens: 3 }])
  })

  it('aggregates buckets and stays bounded', () => {
    const ledger = new UsageLedger(2)
    ledger.record({ at: 't', protocol: 'chat', provider: 'a', model: 'm', status: 200, latencyMs: 10, tokens: 5, ok: true })
    ledger.record({ at: 't', protocol: 'chat', provider: 'a', model: 'm', status: 500, latencyMs: 20, tokens: 0, ok: false })
    ledger.record({ at: 't', protocol: 'chat', provider: 'b', model: 'n', status: 200, latencyMs: 30, tokens: 9, ok: true })
    expect(ledger.size()).toBe(2)
    const summary = ledger.summary()
    expect(summary.requests).toBe(2)
    expect(summary.errors).toBe(1)
    expect(summary.byProviderModel.map(bucket => bucket.provider).sort()).toEqual(['a', 'b'])
  })
})

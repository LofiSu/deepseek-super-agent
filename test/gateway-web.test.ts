import { afterEach, describe, expect, it } from 'vitest'
import { startGatewayServer, type GatewayHandle } from '../src/gateway/server.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

async function startGateway(): Promise<GatewayHandle> {
  const handle = await startGatewayServer({
    host: '127.0.0.1',
    port: 0,
    token: 'tok',
    providers: [{ id: 'p', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', models: ['m'] }],
  })
  cleanup.push(() => handle.close())
  return handle
}

describe('gateway web dashboard', () => {
  it('serves a minimal HTML dashboard at GET /', async () => {
    const gw = await startGateway()
    for (const path of ['/', '/ui']) {
      const res = await fetch(`${gw.url}${path}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type') ?? '').toContain('text/html')
      const body = await res.text()
      expect(body).toContain('ds-agent gateway')
      expect(body).toContain('/health')
    }
  })
})

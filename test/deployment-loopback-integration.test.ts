/**
 * Deployment acceptance against LOCAL simulated HTTP only (no real accounts).
 */
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { A2AHttpTransport } from '../src/channels/a2a-http.ts'
import { createA2AReplayCache, signA2ARequest } from '../src/channels/a2a-auth.ts'
import { createA2AHttpHandler, type A2AHttpHandler } from '../src/channels/a2a-http.ts'
import { A2ARouter } from '../src/channels/a2a.ts'

const PEER = 'sim-peer'
const LOCAL = 'sim-local'
const SECRET = 'deployment-loopback-test-secret-0123456789ab'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => {
    s.close(() => resolve())
    s.closeAllConnections()
  })))
})

async function bindLoopback(handler: A2AHttpHandler): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', resolve)
    server.listen(0, '127.0.0.1')
  })
  const addr = server.address()
  if (typeof addr !== 'object' || addr === null) throw new Error('bind')
  return `http://127.0.0.1:${addr.port}/a2a`
}

describe('deployment loopback integration', () => {
  it('rejects replayed A2A POST on simulated peer (dedupe)', async () => {
    const router = new A2ARouter()
    const handler = createA2AHttpHandler({
      router,
      resolveSecret: id => (id === PEER ? SECRET : undefined),
      replayCache: createA2AReplayCache(),
    })
    router.register(LOCAL, () => {})
    const url = await bindLoopback(handler)
    const body = JSON.stringify({ to: LOCAL, body: { text: 'ping' } })
    const signed = signA2ARequest({ peerId: PEER, secret: SECRET, body })
    const headers = { 'content-type': 'application/json', ...signed.headers }

    const first = await fetch(url, { method: 'POST', headers, body })
    expect(first.status).toBe(200)
    const replay = await fetch(url, { method: 'POST', headers, body })
    expect(replay.status).toBe(401)
  })

  it('client transport targets loopback only and fails closed on bad secret', async () => {
    const router = new A2ARouter()
    const handler = createA2AHttpHandler({
      router,
      resolveSecret: () => SECRET,
      replayCache: createA2AReplayCache(),
    })
    router.register(LOCAL, () => {})
    const url = await bindLoopback(handler)
    const transport = new A2AHttpTransport({ url, peerId: PEER, secret: SECRET })
    const ok = await transport.send({ from: PEER, to: LOCAL, body: { text: 'ok' } })
    expect(ok.status).toBe('delivered')

    const bad = new A2AHttpTransport({
      url,
      peerId: PEER,
      secret: 'wrong-secret-wrong-secret-wrong-secre',
    })
    const failed = await bad.send({ from: PEER, to: LOCAL, body: { text: 'nope' } })
    expect(failed.status).toBe('failed')
  })
})

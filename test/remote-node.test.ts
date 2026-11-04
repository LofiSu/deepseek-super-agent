import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { A2ADelivery, A2AEnvelope } from '../src/channels/a2a.ts'
import type { A2ATransport } from '../src/channels/a2a-transport.ts'
import {
  A2AHttpTransport,
  type A2AHttpHandler,
  type A2AHttpTransportOptions,
} from '../src/channels/a2a-http.ts'
import {
  A2A_AUTH_HEADERS,
  createA2AReplayCache,
  signA2ARequest,
} from '../src/channels/a2a-auth.ts'
import {
  DEFAULT_REMOTE_STALE_MS,
  MeshInbox,
  RemoteMeshRegistry,
  createRemoteMeshHandler,
  type RemoteMeshAssignmentEvent,
  type RemoteMeshHandlerOptions,
} from '../src/harness/remote-node.ts'

const LOCAL = 'router-a'
const PEER = 'peer-worker'
const OTHER_PEER = 'peer-worker-b'
const SECRET = 'remote-mesh-test-secret-never-log-me-0123456789'
const OTHER_SECRET = 'remote-mesh-other-secret-never-log-me-0123456789'
const WRONG_SECRET = 'remote-mesh-wrong-secret-never-log-me-0123456789'
const NOW = 1_700_000_000_000

const servers: Server[] = []
let nonceCounter = 0

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  })))
})

function nextNonce(): string {
  nonceCounter += 1
  return nonceCounter.toString(16).padStart(32, '0')
}

async function listen(handler: A2AHttpHandler): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) {
    throw new Error('remote mesh test server did not bind')
  }
  return `http://127.0.0.1:${address.port}/a2a`
}

interface SignedOverride {
  peerId?: string
  secret?: string
  timestamp?: number
  nonce?: string
}

async function postSigned(
  url: string,
  body: string,
  overrides: SignedOverride = {},
): Promise<Response> {
  const signed = signA2ARequest({
    peerId: overrides.peerId ?? PEER,
    secret: overrides.secret ?? SECRET,
    body,
    timestamp: overrides.timestamp,
    nonce: overrides.nonce ?? nextNonce(),
  })
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signed.headers },
    body,
  })
}

interface InboxHarness {
  url: string
  registry: RemoteMeshRegistry
  received: RemoteMeshAssignmentEvent[]
  inbox: MeshInbox
}

async function startInbox(
  overrides: Partial<RemoteMeshHandlerOptions> & { peers?: Record<string, string> } = {},
): Promise<InboxHarness> {
  const received: RemoteMeshAssignmentEvent[] = []
  const registry = overrides.registry
    ?? new RemoteMeshRegistry({ localPeerId: LOCAL, now: () => Date.now() })
  const peers = overrides.peers ?? {
    [LOCAL]: SECRET,
    [PEER]: SECRET,
    [OTHER_PEER]: OTHER_SECRET,
  }
  const inbox = new MeshInbox({
    localPeerId: LOCAL,
    now: () => Date.now(),
    replayCache: createA2AReplayCache(),
    ...overrides,
    registry,
    resolveSecret: overrides.resolveSecret ?? (peerId => peers[peerId]),
    onAssignment: overrides.onAssignment ?? (event => { received.push(event) }),
  })
  const url = await listen(inbox.handler)
  return { url, registry, received, inbox }
}

function delivered(envelope: A2AEnvelope): A2ADelivery {
  return { envelope, status: 'delivered', delivered: 1, persisted: false }
}

describe('RemoteMeshRegistry registration', () => {
  it('registers nodes, rejects invalid input/duplicates, and never lists secrets', () => {
    const mesh = new RemoteMeshRegistry({ localPeerId: LOCAL, now: () => NOW })
    const base = { url: 'http://127.0.0.1:9/a2a', peerId: PEER, secret: SECRET }

    const registered = mesh.register({ id: 'node-1', ...base })
    expect(registered).toMatchObject({
      id: 'node-1',
      url: base.url,
      peerId: PEER,
      capacity: 1,
      online: true,
      inFlight: 0,
      stale: false,
    })
    expect('secret' in registered).toBe(false)

    expect(() => mesh.register({ id: 'node-1', ...base })).toThrow(/already registered/)
    expect(() => mesh.register({ id: '', ...base })).toThrow(/non-empty id/)
    expect(() => mesh.register({ id: 'x', ...base, peerId: ' ' })).toThrow(/non-empty peerId/)
    expect(() => mesh.register({ id: 'x', ...base, url: '' })).toThrow(/non-empty url/)

    for (const capacity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => mesh.register({
        id: `bad-capacity-${String(capacity)}`,
        ...base,
        capacity,
      })).toThrow(/positive integer capacity/)
    }

    const listed = mesh.list()
    expect(listed).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain(SECRET)
    expect(listed.every(node => !('secret' in node))).toBe(true)

    // Unknown ids are typed/false results, not crashes.
    expect(mesh.heartbeat('missing')).toBe(false)
    expect(mesh.markOffline('missing')).toBe(false)
    expect(mesh.unregister('missing')).toBe(false)
  })

  it('reuses the A2A transport URL guard', () => {
    const mesh = new RemoteMeshRegistry({ localPeerId: LOCAL, now: () => NOW })
    const base = { peerId: PEER, secret: SECRET }
    expect(() => mesh.register({ id: 'plain', url: 'http://example.com/a2a', ...base }))
      .toThrow(/https or a loopback/)
    expect(() => mesh.register({ id: 'ftp', url: 'ftp://127.0.0.1/a2a', ...base }))
      .toThrow(/https or a loopback/)
    expect(() => mesh.register({ id: 'relative', url: '/a2a', ...base }))
      .toThrow(/absolute URL/)
    expect(() => mesh.register({ id: 'https', url: 'https://example.com/a2a', ...base }))
      .not.toThrow()
    expect(() => mesh.register({ id: 'localhost', url: 'http://localhost:9/a2a', ...base }))
      .not.toThrow()
  })
})

describe('RemoteMeshRegistry placement', () => {
  it('picks least-loaded eligible nodes, stays sticky, and respects capacity/staleness', () => {
    let now = NOW
    const mesh = new RemoteMeshRegistry({
      localPeerId: LOCAL,
      now: () => now,
      staleAfterMs: 1_000,
    })
    mesh.register({ id: 'a', url: 'http://127.0.0.1:9/a2a', peerId: 'peer-a', secret: SECRET, capacity: 2 })
    mesh.register({ id: 'b', url: 'http://127.0.0.1:9/a2a', peerId: 'peer-b', secret: SECRET, capacity: 2 })

    expect(mesh.pick('t1', NOW)?.id).toBe('a')
    expect(mesh.pick('t2', NOW)?.id).toBe('b')
    expect(mesh.pick('t1', NOW)?.id).toBe('a')
    expect(mesh.pick('t3', NOW)?.id).toBe('a')
    expect(mesh.pick('t4', NOW)?.id).toBe('b')
    expect(mesh.pick('t5', NOW)).toBeUndefined()
    expect(mesh.inFlight('a')).toBe(2)
    expect(mesh.inFlight('b')).toBe(2)

    mesh.release('t2')
    expect(mesh.pick('t6', NOW)?.id).toBe('b')

    for (const ticket of ['t1', 't3', 't4', 't6']) mesh.release(ticket)
    now = NOW + 1_001
    expect(now - NOW).toBeGreaterThan(1_000)
    expect(mesh.pick('t7', now)).toBeUndefined()

    expect(mesh.heartbeat('a', now)).toBe(true)
    expect(mesh.pick('t7', now)?.id).toBe('a')
    mesh.heartbeat('b', now)
    expect(mesh.markOffline('a')).toBe(true)
    expect(mesh.pick('t8', now)?.id).toBe('b')

    expect(mesh.unregister('b')).toBe(true)
    expect(mesh.inFlight('b')).toBe(0)
    expect(mesh.pick('t9', now)).toBeUndefined()
  })

  it('uses the documented 60 s stale window by default', () => {
    const mesh = new RemoteMeshRegistry({ localPeerId: LOCAL, now: () => NOW })
    mesh.register({ id: 'a', url: 'http://127.0.0.1:9/a2a', peerId: PEER, secret: SECRET })
    expect(DEFAULT_REMOTE_STALE_MS).toBe(60_000)
    expect(mesh.pick('t1', NOW + 60_000)?.id).toBe('a')
    mesh.release('t1')
    expect(mesh.pick('t2', NOW + 60_001)).toBeUndefined()
  })
})

describe('RemoteMeshRegistry dispatch', () => {
  it('requires a pick and refuses stale, offline, and unknown nodes', async () => {
    let now = NOW
    let constructed = 0
    let sends = 0
    const factory = (_options: A2AHttpTransportOptions): A2ATransport => {
      constructed += 1
      return {
        send: (envelope: A2AEnvelope): A2ADelivery => {
          sends += 1
          return delivered(envelope)
        },
      }
    }
    const mesh = new RemoteMeshRegistry({
      localPeerId: LOCAL,
      now: () => now,
      staleAfterMs: 1_000,
      transportFactory: factory,
    })
    mesh.register({ id: 'a', url: 'http://127.0.0.1:9/a2a', peerId: PEER, secret: SECRET })
    expect(constructed).toBe(0)

    // No pick -> no assignment -> no dispatch and no transport construction.
    expect(await mesh.dispatch('t1', { instruction: 'work' })).toBeUndefined()
    expect(constructed).toBe(0)
    expect(sends).toBe(0)

    expect(mesh.pick('t1', NOW)?.id).toBe('a')
    mesh.markOffline('a')
    expect(await mesh.dispatch('t1', { instruction: 'work' })).toBeUndefined()
    expect(sends).toBe(0)

    mesh.heartbeat('a', NOW)
    now = NOW + 1_001
    expect(await mesh.dispatch('t1', { instruction: 'work' })).toBeUndefined()
    expect(sends).toBe(0)

    now = NOW
    mesh.heartbeat('a', NOW)
    const result = await mesh.dispatch('t1', { instruction: 'work' })
    expect(result?.status).toBe('delivered')
    expect(sends).toBe(1)
    expect(constructed).toBe(1)

    // The transport is cached per node and the ticket stays in flight.
    mesh.release('t1')
    expect(mesh.pick('t2', NOW)?.id).toBe('a')
    expect((await mesh.dispatch('t2', { instruction: 'more work' }))?.status).toBe('delivered')
    expect(constructed).toBe(1)

    // Unregistering releases the ticket and makes the node unknown.
    expect(mesh.unregister('a')).toBe(true)
    expect(await mesh.dispatch('t2', { instruction: 'more work' })).toBeUndefined()
    expect(sends).toBe(2)
  })

  it('delivers an assignment envelope through a loopback inbox', async () => {
    const harness = await startInbox()
    const mesh = new RemoteMeshRegistry({ localPeerId: LOCAL, now: () => Date.now() })
    mesh.register({
      id: 'node-1',
      url: harness.url,
      peerId: PEER,
      secret: SECRET,
      capacity: 1,
    })

    expect(mesh.pick('t1')).toMatchObject({ id: 'node-1' })
    const result = await mesh.dispatch('t1', { instruction: 'run the task' })

    expect(result).toMatchObject({ status: 'delivered', delivered: 1, persisted: false })
    expect(harness.received).toHaveLength(1)
    const [event] = harness.received
    expect(event?.peerId).toBe(LOCAL)
    expect(event?.ticketId).toBe('t1')
    expect(event?.assignment).toEqual({ instruction: 'run the task' })
    expect(event?.envelope.from).toBe(LOCAL)
    expect(event?.envelope.to).toBe(PEER)
    expect(event?.envelope.body).toMatchObject({
      kind: 'assignment',
      ticketId: 't1',
      assignment: { instruction: 'run the task' },
    })

    // Delivered assignments keep the only slot reserved.
    expect(mesh.pick('t2')).toBeUndefined()
    expect(mesh.release('t1')).toBe(true)
    expect(mesh.pick('t2')?.id).toBe('node-1')
  })

  it('releases capacity on unroutable/failed/throwing transports without leaking peer text', async () => {
    let mode: 'unroutable' | 'failed' | 'throw' = 'unroutable'
    const factory = (_options: A2AHttpTransportOptions): A2ATransport => ({
      send: async (envelope: A2AEnvelope): Promise<A2ADelivery> => {
        if (mode === 'throw') throw new Error(`peer text ${SECRET}`)
        if (mode === 'unroutable') {
          return { envelope, status: 'unroutable', delivered: 0, persisted: false }
        }
        return {
          envelope,
          status: 'failed',
          delivered: 0,
          persisted: false,
          error: `peer text ${SECRET}`,
        }
      },
    })
    const mesh = new RemoteMeshRegistry({
      localPeerId: LOCAL,
      now: () => NOW,
      transportFactory: factory,
    })
    mesh.register({ id: 'a', url: 'http://127.0.0.1:9/a2a', peerId: PEER, secret: SECRET, capacity: 1 })

    expect(mesh.pick('t1', NOW)?.id).toBe('a')
    const unroutable = await mesh.dispatch('t1', { instruction: 'x' })
    expect(unroutable?.status).toBe('unroutable')
    expect(mesh.inFlight('a')).toBe(0)
    expect(mesh.pick('t2', NOW)?.id).toBe('a')

    mode = 'failed'
    const failed = await mesh.dispatch('t2', { instruction: 'x' })
    expect(failed?.status).toBe('failed')
    expect(JSON.stringify(failed)).not.toContain('peer text')
    expect(JSON.stringify(failed)).not.toContain(SECRET)
    expect(mesh.inFlight('a')).toBe(0)
    expect(mesh.pick('t3', NOW)?.id).toBe('a')

    mode = 'throw'
    const thrown = await mesh.dispatch('t3', { instruction: 'x' })
    expect(thrown?.status).toBe('failed')
    expect(thrown?.error).toBe('remote delivery failed')
    expect(JSON.stringify(thrown)).not.toContain(SECRET)
    expect(mesh.inFlight('a')).toBe(0)
    expect(mesh.pick('t4', NOW)?.id).toBe('a')
  })
})

describe('RemoteMeshRegistry secret hygiene', () => {
  it('never logs or returns secrets or signatures', async () => {
    const logged: unknown[] = []
    const spies = [
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(args) }),
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args) }),
      vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { logged.push(args) }),
    ]
    try {
      const harness = await startInbox()
      const mesh = new RemoteMeshRegistry({ localPeerId: LOCAL, now: () => Date.now() })
      mesh.register({ id: 'node-1', url: harness.url, peerId: PEER, secret: SECRET })
      const listed = JSON.stringify(mesh.list())
      expect(listed).not.toContain(SECRET)

      mesh.pick('t1')
      const result = await mesh.dispatch('t1', { instruction: 'work' })
      expect(result?.status).toBe('delivered')
      const serialized = listed + JSON.stringify(result) + JSON.stringify(harness.registry.list())
      expect(serialized).not.toContain(SECRET)
      expect(serialized).not.toMatch(/[0-9a-f]{64}/u)
      expect(JSON.stringify(logged)).not.toContain(SECRET)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})

describe('remote mesh inbox', () => {
  it('registers and heartbeats a peer over authenticated A2A', async () => {
    const harness = await startInbox()
    const transport = new A2AHttpTransport({ url: harness.url, peerId: PEER, secret: SECRET })

    const registered = await transport.send({
      from: PEER,
      to: LOCAL,
      body: {
        kind: 'register',
        id: 'node-1',
        url: 'http://127.0.0.1:9/a2a',
        capacity: 2,
        // A body-level from claim must never override the authenticated peer.
        from: 'human',
      },
    })
    expect(registered.status).toBe('delivered')
    expect(harness.registry.list()).toHaveLength(1)
    expect(harness.registry.get('node-1')).toMatchObject({
      id: 'node-1',
      peerId: PEER,
      capacity: 2,
      online: true,
    })
    const listed = harness.registry.list()
    expect(JSON.stringify(listed)).not.toContain(SECRET)
    expect(listed.every(node => !('secret' in node))).toBe(true)

    const heartbeat = await transport.send({
      from: PEER,
      to: LOCAL,
      body: { kind: 'heartbeat', id: 'node-1', at: 123 },
    })
    expect(heartbeat.status).toBe('delivered')
    expect(harness.registry.get('node-1')?.lastHeartbeatAt).toBe(123)

    // Omitting the id resolves the peer's single registered node.
    const implicit = await transport.send({
      from: PEER,
      to: LOCAL,
      body: { kind: 'heartbeat' },
    })
    expect(implicit.status).toBe('delivered')
    expect(harness.received).toHaveLength(0)
  })

  it('rejects unknown peers and bad secrets with 401 and never dispatches', async () => {
    const harness = await startInbox()
    const body = JSON.stringify({
      to: LOCAL,
      body: { kind: 'assignment', ticketId: 't1', assignment: { instruction: 'x' } },
    })

    const unknownPeer = await postSigned(harness.url, body, { peerId: 'peer-z' })
    expect(unknownPeer.status).toBe(401)
    expect(await unknownPeer.json()).toEqual({ error: 'unauthorized' })

    const badSecret = await postSigned(harness.url, body, { secret: WRONG_SECRET })
    expect(badSecret.status).toBe(401)

    expect(harness.received).toHaveLength(0)
  })

  it('rejects a replayed nonce with 401 and invokes onAssignment exactly once', async () => {
    const harness = await startInbox()
    const body = JSON.stringify({
      from: PEER,
      to: LOCAL,
      body: { kind: 'assignment', ticketId: 't1', assignment: { instruction: 'once' } },
    })
    const headers = signA2ARequest({
      peerId: PEER,
      secret: SECRET,
      body,
      nonce: nextNonce(),
    }).headers

    const first = await fetch(harness.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    })
    expect(first.status).toBe(200)
    expect(harness.received).toHaveLength(1)

    const replay = await fetch(harness.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    })
    expect(replay.status).toBe(401)
    expect(harness.received).toHaveLength(1)
  })

  it('fails unknown and malformed body kinds closed without invoking onAssignment', async () => {
    const harness = await startInbox()

    const unknownBody = JSON.stringify({ to: LOCAL, body: { kind: 'trigger', text: 'run' } })
    const unknown = await postSigned(harness.url, unknownBody)
    expect([400, 502]).toContain(unknown.status)
    expect(JSON.parse(await unknown.text())).toEqual({ error: 'delivery failed' })

    const malformedBody = JSON.stringify({
      to: LOCAL,
      body: { kind: 'assignment', ticketId: '', assignment: { instruction: 'x' } },
    })
    const malformed = await postSigned(harness.url, malformedBody)
    expect([400, 502]).toContain(malformed.status)

    expect(harness.received).toHaveLength(0)
  })

  it('maps a synchronous callback error to a non-leaking 502', async () => {
    let calls = 0
    const harness = await startInbox({
      onAssignment: () => {
        calls += 1
        throw new Error('sensitive callback failure')
      },
    })
    const body = JSON.stringify({
      to: LOCAL,
      body: { kind: 'assignment', ticketId: 't1', assignment: { instruction: 'x' } },
    })

    const response = await postSigned(harness.url, body)
    expect(response.status).toBe(502)
    const text = await response.text()
    expect(text).not.toContain('sensitive callback failure')
    expect(JSON.parse(text)).toEqual({ error: 'delivery failed' })
    expect(calls).toBe(1)
  })

  it('fails an asynchronous callback closed instead of claiming delivery', async () => {
    let calls = 0
    const harness = await startInbox({
      onAssignment: async () => {
        calls += 1
        throw new Error('late failure')
      },
    })
    const body = JSON.stringify({
      to: LOCAL,
      body: { kind: 'assignment', ticketId: 't1', assignment: { instruction: 'x' } },
    })

    const response = await postSigned(harness.url, body)
    expect(response.status).toBe(502)
    expect(calls).toBe(1)
    // Give the rejected callback a turn; it must not crash the process.
    await new Promise(resolve => setTimeout(resolve, 10))
  })

  it('rejects a duplicate node id registered by another authenticated peer', async () => {
    const harness = await startInbox()
    const first = new A2AHttpTransport({ url: harness.url, peerId: PEER, secret: SECRET })
    const second = new A2AHttpTransport({
      url: harness.url,
      peerId: OTHER_PEER,
      secret: OTHER_SECRET,
    })
    const register = (from: string, id: string) => ({
      from,
      to: LOCAL,
      body: { kind: 'register', id, url: 'http://127.0.0.1:9/a2a', capacity: 1 },
    })

    expect((await first.send(register(PEER, 'node-1'))).status).toBe('delivered')
    expect((await second.send(register(OTHER_PEER, 'node-1'))).status).toBe('failed')

    const listed = harness.registry.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.peerId).toBe(PEER)
  })

  it('does not start a listener by itself', () => {
    const before = servers.length
    const handler = createRemoteMeshHandler({
      onAssignment: () => undefined,
      resolveSecret: () => SECRET,
      localPeerId: LOCAL,
      now: () => Date.now(),
    })
    expect(typeof handler).toBe('function')
    expect(handler.registry).toBeInstanceOf(RemoteMeshRegistry)
    expect(servers).toHaveLength(before)
  })
})

describe('remote mesh auth headers', () => {
  it('never reflects the signature header in an error response', async () => {
    const harness = await startInbox()
    const body = JSON.stringify({ to: LOCAL, body: { kind: 'heartbeat' } })
    const signed = signA2ARequest({ peerId: PEER, secret: SECRET, body, nonce: nextNonce() })
    const signature = signed.headers[A2A_AUTH_HEADERS.signature]!

    const response = await fetch(harness.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signed.headers,
        [A2A_AUTH_HEADERS.signature]: '0'.repeat(64),
      },
      body,
    })
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain(signature)
  })
})

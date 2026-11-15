import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createA2AReplayCache, signA2ARequest } from '../src/channels/a2a-auth.ts'
import type { A2AHttpHandler } from '../src/channels/a2a-http.ts'
import {
  createRemoteMeshHandler,
  type RemoteMeshAssignmentResultEvent,
} from '../src/harness/remote-node.ts'

const HOST = 'router-host'
const WORKER = 'worker-peer'
const SECRET = 'remote-mesh-delivery-key-test-secret-0123456789'

const servers: Server[] = []
let nonceCounter = 0

afterEach(async () => {
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

interface ResultEnvelopeBody {
  kind?: string
  ticketId?: string
  assignmentId?: string
  report?: unknown
  deliveryKey?: unknown
}

function resultBody(overrides: ResultEnvelopeBody = {}): Record<string, unknown> {
  return {
    kind: 'assignment_result',
    ticketId: 'ticket-1',
    assignmentId: 'asg-1',
    report: { kind: 'ready', text: 'done', deliver: false },
    ...overrides,
  }
}

async function postResult(url: string, body: Record<string, unknown>): Promise<Response> {
  const raw = JSON.stringify({ to: HOST, body })
  const signed = signA2ARequest({
    peerId: WORKER,
    secret: SECRET,
    body: raw,
    nonce: nextNonce(),
  })
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signed.headers },
    body: raw,
  })
}

async function startHost(
  onAssignmentResult: (event: RemoteMeshAssignmentResultEvent) => undefined,
): Promise<string> {
  const handler = createRemoteMeshHandler({
    localPeerId: HOST,
    resolveSecret: peer => (peer === WORKER ? SECRET : undefined),
    replayCache: createA2AReplayCache(),
    onAssignment: () => undefined,
    onAssignmentResult,
  })
  return listen(handler)
}

describe('remote mesh assignment_result deliveryKey', () => {
  it('rejects a result that omits deliveryKey instead of falling back to the envelope id', async () => {
    const received: RemoteMeshAssignmentResultEvent[] = []
    const url = await startHost((event) => {
      received.push(event)
      return undefined
    })

    await expect(postResult(url, resultBody())).resolves.toMatchObject({ status: 502 })
    expect(received).toHaveLength(0)
  })

  it('rejects an empty or whitespace deliveryKey', async () => {
    const received: RemoteMeshAssignmentResultEvent[] = []
    const url = await startHost((event) => {
      received.push(event)
      return undefined
    })

    await expect(postResult(url, resultBody({ deliveryKey: '' })))
      .resolves.toMatchObject({ status: 502 })
    await expect(postResult(url, resultBody({ deliveryKey: '   ' })))
      .resolves.toMatchObject({ status: 502 })
    expect(received).toHaveLength(0)
  })

  it('accepts an explicit deliveryKey and passes the body value through unchanged', async () => {
    const received: RemoteMeshAssignmentResultEvent[] = []
    const url = await startHost((event) => {
      received.push(event)
      return undefined
    })

    const response = await postResult(url, resultBody({ deliveryKey: 'deliv-stable-1' }))
    expect(response.status).toBe(200)
    expect(received).toHaveLength(1)
    expect(received[0]?.deliveryKey).toBe('deliv-stable-1')
    // The transport mints its own envelope id; the stable key must not be it.
    expect(received[0]?.deliveryKey).not.toBe(received[0]?.envelope.id)
  })

  it('cannot bypass idempotence by retrying without a deliveryKey', async () => {
    const received: RemoteMeshAssignmentResultEvent[] = []
    const url = await startHost((event) => {
      received.push(event)
      return undefined
    })

    await expect(postResult(url, resultBody())).resolves.toMatchObject({ status: 502 })
    await expect(postResult(url, resultBody())).resolves.toMatchObject({ status: 502 })
    expect(received).toHaveLength(0)
  })
})

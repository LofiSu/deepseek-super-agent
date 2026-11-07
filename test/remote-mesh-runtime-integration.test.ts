import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { A2AHttpTransport } from '../src/channels/a2a-http.ts'
import { createA2AReplayCache } from '../src/channels/a2a-auth.ts'
import { createRemoteMeshHandler } from '../src/harness/remote-node.ts'
import { recordRemoteResult } from '../src/harness/remote-results.ts'
import { Store } from '../src/store/sqlite.ts'
import type { WorkerReport } from '../src/shared/ports.ts'

const HOST = 'router-host'
const WORKER = 'worker-peer'
const SECRET = 'remote-mesh-runtime-test-secret-0123456789ab'

const servers: Server[] = []

async function listen(handler: ReturnType<typeof createRemoteMeshHandler>): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => resolve())
    server.listen(0, '127.0.0.1')
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('bind failed')
  return `http://127.0.0.1:${address.port}/a2a`
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => {
    s.close(() => resolve())
    s.closeAllConnections()
  })))
})

describe('remote mesh runtime e2e (loopback)', () => {
  it('delivers assignment to worker inbox and applies idempotent assignment_result on host', async () => {
    const results: Array<{ ticketId: string; deliveryKey: string }> = []
    let hostUrl = ''
    const hostHandler = createRemoteMeshHandler({
      localPeerId: HOST,
      resolveSecret: peer => (peer === WORKER ? SECRET : undefined),
      replayCache: createA2AReplayCache(),
      onAssignment: () => undefined,
      onAssignmentResult: (event) => {
        results.push({ ticketId: event.ticketId, deliveryKey: event.deliveryKey })
        return undefined
      },
    })
    hostUrl = await listen(hostHandler)

    const assignments: string[] = []
    const workerHandler = createRemoteMeshHandler({
      localPeerId: WORKER,
      allowLoopbackRegistration: true,
      resolveSecret: () => SECRET,
      replayCache: createA2AReplayCache(),
      onAssignment: (event) => {
        assignments.push(event.ticketId)
        const transport = new A2AHttpTransport({ url: hostUrl, peerId: WORKER, secret: SECRET })
        void transport.send({
          from: WORKER,
          to: HOST,
          body: {
            kind: 'assignment_result',
            ticketId: event.ticketId,
            assignmentId: 'asg_e2e',
            deliveryKey: 'deliv-e2e-1',
            report: { kind: 'ready', text: 'remote done', deliver: false },
          },
        })
        return undefined
      },
    })
    const workerUrl = await listen(workerHandler)

    const hostTransport = new A2AHttpTransport({ url: workerUrl, peerId: HOST, secret: SECRET })
    const delivery = await hostTransport.send({
      from: HOST,
      to: WORKER,
      body: {
        kind: 'assignment',
        ticketId: 'ticket_e2e',
        assignment: { assignmentId: 'asg_e2e', brief: 'run remotely' },
      },
    })
    expect(delivery.status).toBe('delivered')
    expect(assignments).toEqual(['ticket_e2e'])
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(results).toHaveLength(1)

    const home = await import('node:os').then(os => import('node:fs').then(fs =>
      fs.mkdtempSync(`${os.tmpdir()}/ds-mesh-e2e-`)))
    const store = new Store(home)
    try {
      const report: WorkerReport = { kind: 'ready', text: 'remote done', deliver: false }
      expect(recordRemoteResult(store, {
        ticketId: 'ticket_e2e',
        assignmentId: 'asg_e2e',
        report,
        deliveryKey: 'deliv-e2e-1',
      })).toBe(true)
      expect(recordRemoteResult(store, {
        ticketId: 'ticket_e2e',
        assignmentId: 'asg_e2e',
        report,
        deliveryKey: 'deliv-e2e-1',
      })).toBe(false)
    } finally {
      store.close()
      await import('node:fs').then(fs => fs.rmSync(home, { recursive: true, force: true }))
    }
  })
})

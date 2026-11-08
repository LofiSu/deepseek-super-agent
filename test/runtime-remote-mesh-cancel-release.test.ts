import { createServer, type Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createA2AReplayCache } from '../src/channels/a2a-auth.ts'
import { imTrigger } from '../src/channels/im.ts'
import {
  createRemoteMeshHandler,
  type RemoteMeshAssignmentCancelEvent,
  type RemoteMeshAssignmentEvent,
} from '../src/harness/remote-node.ts'
import type { Runtime } from '../src/runtime.ts'
import type { Ticket } from '../src/shared/types.ts'
import { freshRuntime, settleWithDeadline, shutdown } from './fixtures.ts'
import { field, lastPrompt, ScriptedModel } from './scripted-model.ts'

const HOST_PEER = 'cancel-pump-host'
const WORKER_PEER = 'cancel-pump-worker'
const SECRET = 'cancel-pump-secret-0123456789abcdef'
const REMOTE_NODE_ID = 'cancel-pump-node'

const servers: Server[] = []
const homes: string[] = []

interface Gate {
  promise: Promise<void>
  release: () => void
}

function gate(): Gate {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

/** Hold the sole local slot with a long Worker turn; router turns just reply. */
function holdingModel(held: Map<string, Gate>): ScriptedModel {
  return new ScriptedModel(async request => {
    if (request.role !== 'worker') return { text: 'router-ok' }
    const ticketId = field(lastPrompt(request), 'ticketId')
    const hold = held.get(ticketId)
    if (hold) {
      await hold.promise
      return { text: 'worker-done' }
    }
    return { text: 'worker-done' }
  })
}

function runtimeFor(home: string, model: ScriptedModel): Runtime {
  return freshRuntime({
    home,
    model,
    meshCapacity: 1,
    instanceId: HOST_PEER,
    remoteResultTimeoutMs: 60_000,
    jobDelayMs: 0,
    watchdogIntervalMs: 600_000,
    stuckMs: 600_000,
    env: {
      ...process.env,
      DS_AGENT_ALLOW_MOCK_FIXTURE: '1',
      DS_AGENT_MESH_CAPACITY: '1',
      DS_AGENT_INSTANCE_ID: HOST_PEER,
      // No env-declared remote peers or capability requirements; the test
      // registers its own loopback node explicitly.
      DS_AGENT_REMOTE_MESH: '',
      DS_AGENT_MESH_REQUIRED_CAPABILITIES: '',
    },
  })
}

function createTicket(runtime: Runtime, slug: string): string {
  runtime.engine.receive(imTrigger({
    id: `trg_${slug}`,
    thread: `topic/${slug}`,
    text: '@ds-agent fix checkout',
  }), { shards: ['default'] })
  const decision = runtime.engine.evaluateDue()[0]
  if (!decision?.ticketId) throw new Error('expected ticket')
  return decision.ticketId
}

function loadTicket(runtime: Runtime, ticketId: string): Ticket {
  const ticket = runtime.store.getDoc<Ticket>('ticket', ticketId)
  if (!ticket) throw new Error(`missing ticket ${ticketId}`)
  return ticket
}

async function waitFor(predicate: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  if (!predicate()) throw new Error(`timed out waiting for ${label}`)
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => {
    s.close(() => resolve())
    s.closeAllConnections()
  })))
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('Runtime remote mesh cancel releases capacity', () => {
  it('pumps a queued Worker after a remote cancel frees the only remote slot', async () => {
    const assignments: RemoteMeshAssignmentEvent[] = []
    const cancels: RemoteMeshAssignmentCancelEvent[] = []
    const workerHandler = createRemoteMeshHandler({
      localPeerId: WORKER_PEER,
      replayCache: createA2AReplayCache(),
      resolveSecret: peer => (peer === HOST_PEER ? SECRET : undefined),
      // Accept the assignment and never send a result: the host only learns the
      // Worker is gone when it cancels the assignment (remote result timeout).
      onAssignment: (event) => {
        assignments.push(event)
        return undefined
      },
      onAssignmentCancel: (event) => {
        cancels.push(event)
        return undefined
      },
    })
    const server = createServer(workerHandler)
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('worker bind failed')
    const workerUrl = `http://127.0.0.1:${address.port}/a2a`

    const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-pump-'))
    homes.push(hostHome)
    const held = new Map<string, Gate>()
    const runtime = runtimeFor(hostHome, holdingModel(held))
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: workerUrl,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    })
    runtime.start({ assessPending: false })

    // A held local Worker keeps the capacity-1 local node full for the whole
    // test, so both tickets below can only use the single remote node.
    const blockerId = createTicket(runtime, 'blocker')
    held.set(blockerId, gate())
    void runtime.harness.launch(loadTicket(runtime, blockerId))
    await waitFor(
      () => runtime.placement.local.inFlight(HOST_PEER) === 1,
      5_000,
      'local worker to reserve the only local slot',
    )

    const remoteTicketId = createTicket(runtime, 'remote_a')
    await runtime.harness.launch(loadTicket(runtime, remoteTicketId))
    await waitFor(
      () => assignments.some(event => event.ticketId === remoteTicketId),
      5_000,
      'ticket A to reach the remote inbox',
    )
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)
    expect(runtime.log.text()).toContain(`[mesh] remote dispatch ticketId=${remoteTicketId}`)

    // The remote slot is full, so ticket B must park in the mesh queue.
    const queuedTicketId = createTicket(runtime, 'remote_b')
    const queuedLaunch = runtime.harness.launch(loadTicket(runtime, queuedTicketId))
    await waitFor(
      () => runtime.log.text().includes(`[mesh] mesh.queued ticketId=${queuedTicketId}`),
      5_000,
      'ticket B to queue behind the full remote node',
    )
    expect(assignments.some(event => event.ticketId === queuedTicketId)).toBe(false)

    // End A's Assignment without ending the Ticket, exactly like the remote
    // result timeout path. The cancel HTTP completes only after a few event
    // loop turns; nothing else in this test pumps afterwards.
    const failed = runtime.engine.report(remoteTicketId, {
      kind: 'failed',
      text: 'remote worker result timeout',
      deliver: false,
    })
    expect(failed.surfaced).toBe(false)

    await waitFor(
      () => cancels.some(event => event.ticketId === remoteTicketId),
      5_000,
      'inbox to receive the cancel for ticket A',
    )
    await waitFor(
      () => assignments.some(event => event.ticketId === queuedTicketId),
      5_000,
      'ticket B to be dispatched to the freed remote node',
    )
    // B now owns the freed slot; capacity was returned between the cancel
    // settling and B's dispatch.
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)
    expect(runtime.log.text()).toContain(`[mesh] mesh.dequeued ticketId=${queuedTicketId}`)
    expect(runtime.log.text()).toContain(`[mesh] remote dispatch ticketId=${queuedTicketId}`)

    queuedLaunch.catch(() => undefined)
    held.get(blockerId)?.release()
    await settleWithDeadline(runtime, 10_000).catch(() => undefined)
    await shutdown(runtime)
  }, 60_000)
})

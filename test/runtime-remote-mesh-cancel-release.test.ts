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

function runtimeFor(
  home: string,
  model: ScriptedModel,
  remoteResultTimeoutMs = 60_000,
): Runtime {
  return freshRuntime({
    home,
    model,
    meshCapacity: 1,
    instanceId: HOST_PEER,
    remoteResultTimeoutMs,
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

  it('keeps a live replacement slot when the cancel releases an ended Assignment', async () => {
    const assignments: RemoteMeshAssignmentEvent[] = []
    const cancels: RemoteMeshAssignmentCancelEvent[] = []
    const workerHandler = createRemoteMeshHandler({
      localPeerId: WORKER_PEER,
      replayCache: createA2AReplayCache(),
      resolveSecret: peer => (peer === HOST_PEER ? SECRET : undefined),
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

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-live-replacement-'))
    homes.push(home)
    const runtime = runtimeFor(home, holdingModel(new Map()))
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: workerUrl,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    })
    runtime.start({ assessPending: false })

    // Occupy the only local slot so placement must choose the remote node.
    expect(runtime.placement.local.pickNode('slot-blocker')?.id).toBe(HOST_PEER)

    const ticketId = createTicket(runtime, 'cancel_live_replacement')
    await runtime.harness.launch(loadTicket(runtime, ticketId))
    await waitFor(
      () => assignments.some(event => event.ticketId === ticketId),
      5_000,
      'ticket to reach the remote inbox',
    )
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)

    const current = loadTicket(runtime, ticketId)
    const armed = current.assignments.at(-1)!
    expect(armed.node).toBe(REMOTE_NODE_ID)
    expect(armed.state).toBe('running')

    // End the armed Assignment through the normal report path. `onAssignmentEnded`
    // queues the cancel/release microtask.
    const failed = runtime.engine.report(ticketId, {
      kind: 'failed',
      text: 'remote worker result timeout',
      deliver: false,
    })
    expect(failed.surfaced).toBe(false)
    const afterReport = loadTicket(runtime, ticketId)
    const ended = afterReport.assignments.at(-1)!
    expect(ended.id).toBe(armed.id)
    expect(ended.state).toBe('ended')

    // Before the release microtask runs, commit a replacement that already
    // claimed the same remote node and started. The sticky reservation stays,
    // so the replacement owns the ticket's remote slot.
    const replacementAssignment = {
      id: 'asg_cancel_live_replacement',
      state: 'running' as const,
      speculative: false,
      node: REMOTE_NODE_ID,
      startedAt: new Date().toISOString(),
    }
    runtime.store.putDoc('ticket', ticketId, {
      ...afterReport,
      assignments: [...afterReport.assignments, replacementAssignment],
    })

    await waitFor(
      () => cancels.some(event => event.ticketId === ticketId),
      5_000,
      'inbox to receive the cancel for the ended Assignment',
    )
    await waitFor(
      () => runtime.log.text().includes(
        `[mesh] remote cancel kept slot ticketId=${ticketId} assignmentId=${armed.id} replacementId=${replacementAssignment.id}`,
      ),
      5_000,
      'late cancel to keep the live replacement slot',
    )

    // The ended remote worker is still told to stop; the live replacement is
    // neither cancelled nor touched.
    expect(cancels.find(event => event.ticketId === ticketId)?.assignmentId).toBe(armed.id)
    const after = loadTicket(runtime, ticketId)
    const latest = after.assignments.at(-1)!
    expect(latest.id).toBe(replacementAssignment.id)
    expect(latest.state).toBe('running')
    expect(latest.report).toBeUndefined()
    expect(after.ended).toBeUndefined()
    // The cancel must not steal the live replacement's mesh capacity.
    expect(runtime.placement.remote?.hasTicketAssignment(ticketId)).toBe(true)
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)

    await shutdown(runtime)
  }, 60_000)

  it('re-arms the live replacement wait after a late cancel keep-slot', async () => {
    const assignments: RemoteMeshAssignmentEvent[] = []
    const cancels: RemoteMeshAssignmentCancelEvent[] = []
    const workerHandler = createRemoteMeshHandler({
      localPeerId: WORKER_PEER,
      replayCache: createA2AReplayCache(),
      resolveSecret: peer => (peer === HOST_PEER ? SECRET : undefined),
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

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-live-replacement-rearm-'))
    homes.push(home)
    const runtime = runtimeFor(home, holdingModel(new Map()), 300)
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: workerUrl,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    })
    runtime.start({ assessPending: false })

    // Occupy the only local slot so placement must choose the remote node.
    expect(runtime.placement.local.pickNode('slot-blocker')?.id).toBe(HOST_PEER)

    const ticketId = createTicket(runtime, 'late_cancel_rearm')
    await runtime.harness.launch(loadTicket(runtime, ticketId))
    await waitFor(
      () => assignments.some(event => event.ticketId === ticketId),
      5_000,
      'ticket to reach the remote inbox',
    )
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)

    const current = loadTicket(runtime, ticketId)
    const armed = current.assignments.at(-1)!
    expect(armed.node).toBe(REMOTE_NODE_ID)
    expect(armed.state).toBe('running')

    // Let the original wait arm first so the later transfer is a distinct arm.
    await waitFor(
      () => runtime.log.text().includes(
        `[mesh] remote result wait armed ticketId=${ticketId} assignmentId=${armed.id}`,
      ),
      5_000,
      'remote result wait to arm before the report',
    )

    // End the armed Assignment through the normal report path. `onAssignmentEnded`
    // clears the per-ticket wait and queues the cancel/release microtask.
    const failed = runtime.engine.report(ticketId, {
      kind: 'failed',
      text: 'remote worker result timeout',
      deliver: false,
    })
    expect(failed.surfaced).toBe(false)
    const afterReport = loadTicket(runtime, ticketId)
    const ended = afterReport.assignments.at(-1)!
    expect(ended.id).toBe(armed.id)
    expect(ended.state).toBe('ended')

    // Before the release microtask runs, commit a replacement that already
    // claimed the same remote node and started, with no wait of its own. The
    // cancel keep-slot path must transfer the wait onto it.
    const replacementAssignment = {
      id: 'asg_cancel_live_replacement_rearm',
      state: 'running' as const,
      speculative: false,
      node: REMOTE_NODE_ID,
      startedAt: new Date().toISOString(),
    }
    runtime.store.putDoc('ticket', ticketId, {
      ...afterReport,
      assignments: [...afterReport.assignments, replacementAssignment],
    })

    await waitFor(
      () => runtime.log.text().includes(
        `[mesh] remote cancel kept slot ticketId=${ticketId} assignmentId=${armed.id} replacementId=${replacementAssignment.id}`,
      ),
      5_000,
      'late cancel to keep the live replacement slot',
    )
    await waitFor(
      () => runtime.log.text().includes(
        `[mesh] remote result wait armed ticketId=${ticketId} assignmentId=${replacementAssignment.id}`,
      ),
      5_000,
      'cancel keep-slot to transfer the wait to the live replacement',
    )

    // The transferred wait now fires for the replacement: report the failed
    // timeout, end the hung replacement, and free the sticky slot.
    await waitFor(
      () => runtime.log.text().includes(
        `[mesh] remote result timeout ticketId=${ticketId} assignmentId=${replacementAssignment.id}`,
      ),
      5_000,
      'replacement result timeout to fire',
    )
    await waitFor(
      () => loadTicket(runtime, ticketId).assignments.at(-1)!.state === 'ended',
      5_000,
      'replacement Assignment to end after its timeout',
    )
    await waitFor(
      () => runtime.placement.remote?.hasTicketAssignment(ticketId) === false,
      5_000,
      'sticky remote slot to be released after the replacement timeout',
    )

    const after = loadTicket(runtime, ticketId)
    const latest = after.assignments.at(-1)!
    expect(latest.id).toBe(replacementAssignment.id)
    expect(latest.report?.kind).toBe('failed')
    expect(latest.report?.text).toBe('remote worker result timeout')
    expect(after.ended).toBeUndefined()
    // The cancel still targets the ended Assignment, not the replacement.
    expect(cancels.find(event => event.ticketId === ticketId)?.assignmentId).toBe(armed.id)
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(0)

    await shutdown(runtime)
  }, 60_000)

  it('keeps a retry replacement slot when the cancel settles after it is dispatched', async () => {
    const assignments: RemoteMeshAssignmentEvent[] = []
    const cancels: RemoteMeshAssignmentCancelEvent[] = []
    const workerHandler = createRemoteMeshHandler({
      localPeerId: WORKER_PEER,
      replayCache: createA2AReplayCache(),
      resolveSecret: peer => (peer === HOST_PEER ? SECRET : undefined),
      onAssignment: (event) => {
        assignments.push(event)
        return undefined
      },
      onAssignmentCancel: (event) => {
        cancels.push(event)
        return undefined
      },
    })
    // Hold the cancel request (the first request after the release microtask
    // starts it) at the inbox until the retry replacement has been launched,
    // placed, and dispatched. The send must not settle before then.
    const cancelGate = gate()
    let holdNextRequest = false
    let onCancelHeld!: () => void
    const cancelHeld = new Promise<void>(resolve => { onCancelHeld = resolve })
    const server = createServer((req, res) => {
      if (holdNextRequest) {
        holdNextRequest = false
        onCancelHeld()
        void cancelGate.promise.then(() => workerHandler(req, res))
        return
      }
      void workerHandler(req, res)
    })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('worker bind failed')
    const workerUrl = `http://127.0.0.1:${address.port}/a2a`

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-retry-race-'))
    homes.push(home)
    const runtime = runtimeFor(home, holdingModel(new Map()))
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: workerUrl,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    })
    runtime.start({ assessPending: false })

    // Occupy the only local slot so placement must choose the remote node.
    expect(runtime.placement.local.pickNode('slot-blocker')?.id).toBe(HOST_PEER)

    const ticketId = createTicket(runtime, 'cancel_retry_race')
    await runtime.harness.launch(loadTicket(runtime, ticketId))
    await waitFor(
      () => assignments.some(event => event.ticketId === ticketId),
      5_000,
      'ticket to reach the remote inbox',
    )
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)

    const current = loadTicket(runtime, ticketId)
    const armed = current.assignments.at(-1)!
    expect(armed.node).toBe(REMOTE_NODE_ID)
    expect(armed.state).toBe('running')

    // End the armed Assignment through the normal report path. `onAssignmentEnded`
    // queues the cancel/release microtask, which starts a releasing cancel only
    // after it re-reads the Ticket and sees no replacement yet.
    holdNextRequest = true
    const failed = runtime.engine.report(ticketId, {
      kind: 'failed',
      text: 'remote worker result timeout',
      deliver: false,
    })
    expect(failed.surfaced).toBe(false)

    // The default cancel path is now in flight and parked at the inbox.
    await cancelHeld

    // A genuine relaunch runs before that cancel settles. The sticky remote
    // reservation is still present, so the retry is placed and dispatched to
    // the same node while the old cancel is still awaiting its response.
    await runtime.retry(ticketId)
    await waitFor(
      () => assignments.some(
        event => event.ticketId === ticketId
          && (event.assignment as { id?: string } | undefined)?.id !== armed.id,
      ),
      5_000,
      'retry Assignment to reach the remote inbox',
    )
    const replaced = loadTicket(runtime, ticketId)
    const replacement = replaced.assignments.at(-1)!
    expect(replacement.id).not.toBe(armed.id)
    expect(replacement.state).toBe('running')
    expect(runtime.placement.remote?.hasTicketAssignment(ticketId)).toBe(true)
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)

    // Let the in-flight cancel settle now that the replacement owns the slot.
    cancelGate.release()

    await waitFor(
      () => cancels.some(event => event.ticketId === ticketId),
      5_000,
      'inbox to receive the cancel for the ended Assignment',
    )
    await waitFor(
      () => runtime.log.text().includes(
        `[mesh] remote cancel kept slot ticketId=${ticketId} assignmentId=${armed.id} replacementId=${replacement.id} reason=live-replacement`,
      ),
      5_000,
      'settled cancel to keep the retry replacement slot',
    )

    const after = loadTicket(runtime, ticketId)
    const latest = after.assignments.at(-1)!
    expect(latest.id).toBe(replacement.id)
    expect(latest.state).toBe('running')
    expect(latest.report).toBeUndefined()
    expect(after.ended).toBeUndefined()
    // The cancel still targets the ended Assignment, not the retry.
    expect(cancels.find(event => event.ticketId === ticketId)?.assignmentId).toBe(armed.id)
    // The settled cancel must not steal the retry replacement's mesh capacity.
    expect(runtime.placement.remote?.hasTicketAssignment(ticketId)).toBe(true)
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)
    // The wait was re-armed for the live replacement.
    expect(runtime.log.text()).toContain(
      `[mesh] remote result wait armed ticketId=${ticketId} assignmentId=${replacement.id}`,
    )

    await shutdown(runtime)
  }, 60_000)

  it('cancels the ended remote Assignment when recovery releases a pending replacement', async () => {
    const assignments: RemoteMeshAssignmentEvent[] = []
    const cancels: RemoteMeshAssignmentCancelEvent[] = []
    const workerHandler = createRemoteMeshHandler({
      localPeerId: WORKER_PEER,
      replayCache: createA2AReplayCache(),
      resolveSecret: peer => (peer === HOST_PEER ? SECRET : undefined),
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

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-recovery-target-'))
    homes.push(home)
    const runtime = runtimeFor(home, holdingModel(new Map()))
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: workerUrl,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    })
    runtime.start({ assessPending: false })

    // Occupy the only local slot so placement must choose the remote node.
    expect(runtime.placement.local.pickNode('slot-blocker')?.id).toBe(HOST_PEER)

    const ticketId = createTicket(runtime, 'cancel_recovery_target')
    await runtime.harness.launch(loadTicket(runtime, ticketId))
    await waitFor(
      () => assignments.some(event => event.ticketId === ticketId),
      5_000,
      'ticket to reach the remote inbox',
    )
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)

    const armed = loadTicket(runtime, ticketId).assignments.at(-1)!
    expect(armed.node).toBe(REMOTE_NODE_ID)
    expect(armed.state).toBe('running')

    // Real restart recovery ends the running Assignment, appends a pending
    // replacement, and queues the release microtask. The pending replacement is
    // visible before `releaseSlot` starts and is deliberately not live.
    const recovered = runtime.engine.recoverInterrupted()
    expect(recovered.map(item => item.ticketId)).toContain(ticketId)
    const afterRecovery = loadTicket(runtime, ticketId)
    const ended = afterRecovery.assignments.find(item => item.id === armed.id)!
    expect(ended.state).toBe('ended')
    const replacement = afterRecovery.assignments.at(-1)!
    expect(replacement.id).not.toBe(armed.id)
    expect(replacement.state).toBe('pending')
    expect(replacement.node).toBeUndefined()
    expect(replacement.startedAt).toBeUndefined()

    await waitFor(
      () => cancels.some(event => event.ticketId === ticketId),
      5_000,
      'inbox to receive the cancel for the ended Assignment',
    )
    // The unplaced pending replacement is not live, so the sticky slot is
    // conservatively released after the cancel settles.
    await waitFor(
      () => runtime.placement.remote?.hasTicketAssignment(ticketId) === false,
      5_000,
      'sticky remote slot to be released',
    )
    await waitFor(
      () => runtime.placement.remote?.inFlight(REMOTE_NODE_ID) === 0,
      5_000,
      'remote capacity to be released',
    )

    // The authenticated cancel must target the Assignment that ran on the
    // worker, not the pending replacement the worker never received.
    const cancel = cancels.find(event => event.ticketId === ticketId)
    expect(cancel?.assignmentId).toBe(armed.id)
    expect(cancel?.assignmentId).not.toBe(replacement.id)

    const after = loadTicket(runtime, ticketId)
    const latest = after.assignments.at(-1)!
    expect(latest.id).toBe(replacement.id)
    expect(latest.state).toBe('pending')
    expect(after.ended).toBeUndefined()

    await shutdown(runtime)
  }, 60_000)

  it('cancels the ended remote Assignment after a process restart', async () => {
    const assignments: RemoteMeshAssignmentEvent[] = []
    const cancels: RemoteMeshAssignmentCancelEvent[] = []
    const workerHandler = createRemoteMeshHandler({
      localPeerId: WORKER_PEER,
      replayCache: createA2AReplayCache(),
      resolveSecret: peer => (peer === HOST_PEER ? SECRET : undefined),
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

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-process-restart-'))
    homes.push(home)
    const node = {
      id: REMOTE_NODE_ID,
      url: workerUrl,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    }

    // Runtime A: place the ticket on the remote peer and leave it running there.
    const runtimeA = runtimeFor(home, holdingModel(new Map()))
    runtimeA.placement.registerRemoteNode(node)
    runtimeA.start({ assessPending: false })
    // Occupy the only local slot so placement must choose the remote node.
    expect(runtimeA.placement.local.pickNode('slot-blocker')?.id).toBe(HOST_PEER)

    const ticketId = createTicket(runtimeA, 'cancel_process_restart')
    await runtimeA.harness.launch(loadTicket(runtimeA, ticketId))
    await waitFor(
      () => assignments.some(event => event.ticketId === ticketId),
      5_000,
      'ticket to reach the remote inbox',
    )
    const armed = loadTicket(runtimeA, ticketId).assignments.at(-1)!
    expect(armed.node).toBe(REMOTE_NODE_ID)
    expect(armed.state).toBe('running')
    expect(runtimeA.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)
    // The worker accepted the Assignment and never returned a result.
    expect(cancels).toHaveLength(0)

    // Crash the host without cancelling: stop the daemon and close SQLite while
    // the remote worker still runs the accepted Assignment.
    runtimeA.daemon.stop()
    runtimeA.store.close()
    expect(cancels).toHaveLength(0)

    // Runtime B: the production restart path. A fresh process has an empty
    // sticky map, so recovery must rebuild it from the persisted Assignment
    // node before ending the running Assignment.
    const runtimeB = runtimeFor(home, holdingModel(new Map()))
    runtimeB.placement.registerRemoteNode(node)
    runtimeB.start({ assessPending: false })

    const recovered = loadTicket(runtimeB, ticketId)
    const ended = recovered.assignments.find(item => item.id === armed.id)!
    expect(ended.state).toBe('ended')
    const replacement = recovered.assignments.at(-1)!
    expect(replacement.id).not.toBe(armed.id)
    expect(['pending', 'running']).toContain(replacement.state)

    // The required result: the restarted host tells the worker to stop the
    // Assignment that actually ran. A2 may still be pending or already
    // dispatched, so only A1's cancel is asserted.
    await waitFor(
      () => cancels.some(event => event.ticketId === ticketId),
      5_000,
      'inbox to receive the cancel for the interrupted Assignment',
    )
    const cancel = cancels.find(event => event.ticketId === ticketId)
    expect(cancel?.assignmentId).toBe(armed.id)
    expect(cancel?.assignmentId).not.toBe(replacement.id)
    // The cancel was only possible because recovery rebuilt the sticky
    // reservation from persisted state before `releaseSlot` ran.
    expect(runtimeB.log.text()).toContain(
      `[recovery] remote reservation restored ticketId=${ticketId} assignmentId=${armed.id} node=${REMOTE_NODE_ID}`,
    )

    await shutdown(runtimeB)
  }, 60_000)

  it('cancels an ended remote Assignment left behind by a mid-recovery crash', async () => {
    const assignments: RemoteMeshAssignmentEvent[] = []
    const cancels: RemoteMeshAssignmentCancelEvent[] = []
    const workerHandler = createRemoteMeshHandler({
      localPeerId: WORKER_PEER,
      replayCache: createA2AReplayCache(),
      resolveSecret: peer => (peer === HOST_PEER ? SECRET : undefined),
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

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-mid-recovery-'))
    homes.push(home)
    const node = {
      id: REMOTE_NODE_ID,
      url: workerUrl,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
    }

    // Runtime A: dispatch a running remote Assignment. The worker accepts it
    // and never returns a result.
    const runtimeA = runtimeFor(home, holdingModel(new Map()))
    runtimeA.placement.registerRemoteNode(node)
    runtimeA.start({ assessPending: false })
    expect(runtimeA.placement.local.pickNode('slot-blocker')?.id).toBe(HOST_PEER)

    const ticketId = createTicket(runtimeA, 'cancel_mid_recovery')
    await runtimeA.harness.launch(loadTicket(runtimeA, ticketId))
    await waitFor(
      () => assignments.some(event => event.ticketId === ticketId),
      5_000,
      'ticket to reach the remote inbox',
    )
    const armed = loadTicket(runtimeA, ticketId).assignments.at(-1)!
    expect(armed.node).toBe(REMOTE_NODE_ID)
    expect(armed.state).toBe('running')

    // Host crash without a cancel.
    runtimeA.daemon.stop()
    runtimeA.store.close()
    expect(cancels).toHaveLength(0)

    // Runtime B: the production restart path commits recovery (A1 ended, one
    // pending replacement, RECOVERED input) and queues `releaseSlot` as a
    // microtask. Crash synchronously after `start()` returns, before that
    // microtask can send the cancel, while the worker still holds A1.
    const runtimeB = runtimeFor(home, holdingModel(new Map()))
    runtimeB.placement.registerRemoteNode(node)
    runtimeB.start({ assessPending: false })

    const recoveredB = loadTicket(runtimeB, ticketId)
    const ended = recoveredB.assignments.find(item => item.id === armed.id)!
    expect(ended.state).toBe('ended')
    const replacement = recoveredB.assignments.at(-1)!
    expect(replacement.id).not.toBe(armed.id)
    expect(replacement.state).toBe('pending')

    runtimeB.daemon.stop()
    runtimeB.store.close()
    // Let B's queued microtask run against the closed store so it cannot
    // deliver a cancel for A1.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(cancels).toHaveLength(0)

    // Runtime C: recovery finds no running Assignment (A1 is already ended and
    // the replacement is still pending), so it only relaunches A2. It must
    // still rebuild sticky from the ended remote predecessor and send A1's
    // cancel before (or while) A2 is dispatched to the same worker.
    const runtimeC = runtimeFor(home, holdingModel(new Map()))
    runtimeC.placement.registerRemoteNode(node)
    runtimeC.start({ assessPending: false })

    expect(runtimeC.log.text()).toContain(
      `[recovery] remote reservation restored ticketId=${ticketId} assignmentId=${armed.id} node=${REMOTE_NODE_ID} state=ended`,
    )

    await waitFor(
      () => cancels.some(event => event.ticketId === ticketId),
      5_000,
      'inbox to receive the leftover cancel for the ended Assignment',
    )
    const cancel = cancels.find(event => event.ticketId === ticketId)
    expect(cancel?.assignmentId).toBe(armed.id)
    expect(cancel?.assignmentId).not.toBe(replacement.id)

    // A2 may be pending or already dispatched; either way A1 is not left
    // running on the worker uncancelled.
    await waitFor(
      () => assignments.some(event =>
        (event.assignment as { assignmentId?: string } | undefined)?.assignmentId === replacement.id),
      5_000,
      'replacement Assignment to reach the remote inbox',
    )
    const current = loadTicket(runtimeC, ticketId)
    expect(current.assignments.find(item => item.id === armed.id)?.state).toBe('ended')
    expect(cancels.filter(event => event.assignmentId === armed.id)).toHaveLength(1)

    await shutdown(runtimeC)
  }, 60_000)
})

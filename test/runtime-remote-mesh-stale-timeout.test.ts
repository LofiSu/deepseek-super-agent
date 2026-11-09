import { createServer, type Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createA2AReplayCache } from '../src/channels/a2a-auth.ts'
import { imTrigger } from '../src/channels/im.ts'
import {
  createRemoteMeshHandler,
  type RemoteMeshAssignmentEvent,
} from '../src/harness/remote-node.ts'
import type { Runtime } from '../src/runtime.ts'
import type { Ticket } from '../src/shared/types.ts'
import { freshRuntime, shutdown } from './fixtures.ts'
import { ScriptedModel } from './scripted-model.ts'

const HOST_PEER = 'stale-timeout-host'
const WORKER_PEER = 'stale-timeout-worker'
const SECRET = 'stale-timeout-secret-0123456789abcdef'
const REMOTE_NODE_ID = 'stale-timeout-node'
// The in-process node advertises no capabilities, so a non-empty requirement
// forces placement onto the registered remote node.
const REQUIRED_CAPABILITY = 'stale-timeout-only'
const RESULT_TIMEOUT_MS = 300

const servers: Server[] = []
const homes: string[] = []

function runtimeFor(home: string): Runtime {
  return freshRuntime({
    home,
    model: new ScriptedModel(async request => {
      if (request.role !== 'worker') return { text: 'router-ok' }
      // The worker never runs on the host: the ticket is placed remotely and
      // the loopback inbox accepts the assignment without ever answering.
      return { text: 'worker-done' }
    }),
    meshCapacity: 1,
    instanceId: HOST_PEER,
    remoteResultTimeoutMs: RESULT_TIMEOUT_MS,
    jobDelayMs: 0,
    watchdogIntervalMs: 600_000,
    stuckMs: 600_000,
    env: {
      ...process.env,
      DS_AGENT_ALLOW_MOCK_FIXTURE: '1',
      DS_AGENT_MESH_CAPACITY: '1',
      DS_AGENT_INSTANCE_ID: HOST_PEER,
      DS_AGENT_REMOTE_MESH: '',
      DS_AGENT_MESH_REQUIRED_CAPABILITIES: REQUIRED_CAPABILITY,
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

interface WorkerInbox {
  url: string
  assignments: RemoteMeshAssignmentEvent[]
}

async function startInbox(options: {
  /** Called for every inbound HTTP request before the mesh handler runs. */
  beforeHandle?: () => void
  /** Resolves before the assignment request is answered, to widen the race. */
  deliveryGate?: Promise<void>
} = {}): Promise<WorkerInbox> {
  const assignments: RemoteMeshAssignmentEvent[] = []
  const handler = createRemoteMeshHandler({
    localPeerId: WORKER_PEER,
    replayCache: createA2AReplayCache(),
    resolveSecret: peer => (peer === HOST_PEER ? SECRET : undefined),
    // Accept the assignment and never send a result.
    onAssignment: event => {
      assignments.push(event)
      return undefined
    },
    onAssignmentCancel: () => undefined,
  })
  const server = createServer((req, res) => {
    options.beforeHandle?.()
    if (options.deliveryGate) void options.deliveryGate.then(() => handler(req, res))
    else handler(req, res)
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('worker bind failed')
  return { url: `http://127.0.0.1:${address.port}/a2a`, assignments }
}

function startHost(inbox: WorkerInbox): Runtime {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-stale-timeout-'))
  homes.push(home)
  const runtime = runtimeFor(home)
  runtime.placement.registerRemoteNode({
    id: REMOTE_NODE_ID,
    url: inbox.url,
    peerId: WORKER_PEER,
    secret: SECRET,
    capacity: 1,
    capabilities: [REQUIRED_CAPABILITY],
  })
  runtime.start({ assessPending: false })
  return runtime
}

async function dispatchToRemote(runtime: Runtime, inbox: WorkerInbox, slug: string): Promise<string> {
  const ticketId = createTicket(runtime, slug)
  void runtime.harness.launch(loadTicket(runtime, ticketId))
  await waitFor(
    () => inbox.assignments.some(event => event.ticketId === ticketId),
    5_000,
    'ticket to reach the remote inbox',
  )
  await waitFor(
    () => runtime.placement.remote?.inFlight(REMOTE_NODE_ID) === 1,
    5_000,
    'remote slot to be reserved',
  )
  return ticketId
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => {
    s.close(() => resolve())
    s.closeAllConnections()
  })))
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('Runtime stale remote result timeout', () => {
  it('does not fail the replacement Assignment when recovery ends the armed one', async () => {
    const inbox = await startInbox()
    const runtime = startHost(inbox)
    const ticketId = await dispatchToRemote(runtime, inbox, 'recover_stale')
    const armedId = loadTicket(runtime, ticketId).assignments.at(-1)!.id

    // Recovery ends the running Assignment and queues a replacement without
    // reporting. The remote result wait still points at the ended Assignment.
    const recovered = runtime.engine.recoverInterrupted()
    expect(recovered.map(item => item.ticketId)).toContain(ticketId)
    const replacement = loadTicket(runtime, ticketId).assignments.at(-1)!
    expect(replacement.id).not.toBe(armedId)
    expect(replacement.state).toBe('pending')
    expect(replacement.report).toBeUndefined()

    // Wait well past the result timeout. The old timer must not report a
    // timeout on the replacement Assignment.
    await sleep(RESULT_TIMEOUT_MS + 250)

    const after = loadTicket(runtime, ticketId)
    const latest = after.assignments.at(-1)!
    expect(latest.id).toBe(replacement.id)
    expect(latest.report).toBeUndefined()
    expect(latest.state).toBe('pending')
    expect(after.ended).toBeUndefined()
    expect(runtime.log.text()).not.toContain(`remote worker result timeout`)

    // The abandoned remote slot must be freed even though no Assignment ended
    // through the normal report path.
    await waitFor(
      () => runtime.placement.remote?.inFlight(REMOTE_NODE_ID) === 0,
      5_000,
      'remote capacity to be released',
    )
    expect(runtime.placement.remote?.hasTicketAssignment(ticketId)).toBe(false)

    await shutdown(runtime)
  }, 60_000)

  it('ignores a timeout whose armed Assignment was replaced without a lifecycle hook', async () => {
    const inbox = await startInbox()
    const runtime = startHost(inbox)
    const ticketId = await dispatchToRemote(runtime, inbox, 'replaced_stale')
    const current = loadTicket(runtime, ticketId)
    const armed = current.assignments.at(-1)!

    // Simulate recovery that committed the end + replacement directly, with no
    // onAssignmentEnded: the timer stays armed for the old Assignment id.
    const replacement: Ticket = {
      ...current,
      assignments: [
        { ...armed, state: 'ended', endedAt: new Date().toISOString() },
        { id: 'asg_replaced_after_recovery', state: 'pending', speculative: false },
      ],
    }
    runtime.store.putDoc('ticket', ticketId, replacement)

    await sleep(RESULT_TIMEOUT_MS + 250)

    const after = loadTicket(runtime, ticketId)
    const latest = after.assignments.at(-1)!
    expect(latest.id).toBe('asg_replaced_after_recovery')
    expect(latest.state).toBe('pending')
    expect(latest.report).toBeUndefined()
    expect(after.ended).toBeUndefined()
    expect(runtime.log.text()).toContain(
      `[mesh] remote result timeout ignored ticketId=${ticketId} assignmentId=${armed.id}`,
    )
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(0)

    await shutdown(runtime)
  }, 60_000)

  it('defers a pause-held timeout, keeps the remote slot, and recovers after resume', async () => {
    const inbox = await startInbox()
    const runtime = startHost(inbox)
    const ticketId = await dispatchToRemote(runtime, inbox, 'paused_timeout')
    const armedId = loadTicket(runtime, ticketId).assignments.at(-1)!.id

    // Pause before the result wait fires. `Assignments.report` then holds the
    // failed verdict on the Assignment instead of ending it.
    runtime.engine.pause(ticketId, { reason: 'owner review' })
    const deferredLine =
      `[mesh] remote result timeout deferred ticketId=${ticketId} assignmentId=${armedId}`
    const deferredCount = (): number => runtime.log.text().split(deferredLine).length - 1

    await waitFor(() => deferredCount() >= 1, 5_000, 'first deferred timeout log')
    const paused = loadTicket(runtime, ticketId)
    const held = paused.assignments.at(-1)!
    expect(held.id).toBe(armedId)
    expect(held.state).not.toBe('ended')
    expect(held.report?.kind).toBe('failed')
    expect(held.report?.verdict).toBe('hold')
    expect(paused.ended).toBeUndefined()
    // The slot stays reserved while the held report waits for resume.
    expect(runtime.placement.remote?.hasTicketAssignment(ticketId)).toBe(true)
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)
    // No terminal timeout failure was applied.
    expect(runtime.log.text()).not.toContain('remote worker result timeout')

    // A second window proves the timer was re-armed instead of dropped.
    await waitFor(() => deferredCount() >= 2, 5_000, 'second deferred timeout log')
    expect(loadTicket(runtime, ticketId).assignments.at(-1)!.state).not.toBe('ended')
    expect(runtime.placement.remote?.hasTicketAssignment(ticketId)).toBe(true)

    // Resume clears the pause. The next timeout now applies the failed report,
    // ends the Assignment, and frees the reserved slot.
    runtime.engine.resume(ticketId, { reason: 'owner resumed' })
    await waitFor(
      () => loadTicket(runtime, ticketId).assignments.at(-1)!.state === 'ended',
      5_000,
      'assignment to end after resume',
    )
    expect(loadTicket(runtime, ticketId).ended).toBeUndefined()
    await waitFor(
      () => runtime.placement.remote?.hasTicketAssignment(ticketId) === false,
      5_000,
      'remote slot to be released after resume',
    )
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(0)

    await shutdown(runtime)
  }, 60_000)

  it('does not arm a result wait when the Assignment is replaced while dispatch awaits', async () => {
    let releaseDelivery!: () => void
    const deliveryGate = new Promise<void>(resolve => { releaseDelivery = resolve })
    let requested = false
    const inbox = await startInbox({
      beforeHandle: () => { requested = true },
      deliveryGate,
    })
    const runtime = startHost(inbox)
    const ticketId = createTicket(runtime, 'late_dispatch_stale')
    const launch = runtime.harness.launch(loadTicket(runtime, ticketId))

    // The HTTP send is still awaiting its response: no result wait is armed yet.
    await waitFor(() => requested, 5_000, 'remote assignment request to arrive')

    const recovered = runtime.engine.recoverInterrupted()
    expect(recovered.map(item => item.ticketId)).toContain(ticketId)
    const replacement = loadTicket(runtime, ticketId).assignments.at(-1)!
    expect(replacement.state).toBe('pending')

    // Let the original dispatch finish successfully. Its Assignment is no
    // longer current, so it must not arm a timeout for the replacement.
    releaseDelivery()
    await waitFor(
      () => runtime.log.text().includes(`[mesh] remote result wait skipped ticketId=${ticketId}`),
      5_000,
      'late dispatch to skip arming the result wait',
    )
    launch.catch(() => undefined)

    await sleep(RESULT_TIMEOUT_MS + 250)

    const after = loadTicket(runtime, ticketId)
    const latest = after.assignments.at(-1)!
    expect(latest.id).toBe(replacement.id)
    expect(latest.state).toBe('pending')
    expect(latest.report).toBeUndefined()
    expect(after.ended).toBeUndefined()
    await waitFor(
      () => runtime.placement.remote?.inFlight(REMOTE_NODE_ID) === 0,
      5_000,
      'remote capacity to be released after the late dispatch',
    )

    await shutdown(runtime)
  }, 60_000)
})

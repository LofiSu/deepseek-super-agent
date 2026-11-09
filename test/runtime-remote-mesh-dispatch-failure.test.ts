import { createServer, type Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import type { Runtime } from '../src/runtime.ts'
import type { Ticket } from '../src/shared/types.ts'
import { freshRuntime, shutdown } from './fixtures.ts'
import { ScriptedModel } from './scripted-model.ts'

const HOST_PEER = 'dispatch-fail-host'
const WORKER_PEER = 'dispatch-fail-worker'
const SECRET = 'dispatch-fail-secret-0123456789abcdef'
const REMOTE_NODE_ID = 'dispatch-fail-node'
// The in-process node advertises no capabilities, so a non-empty requirement
// forces placement onto the registered remote node.
const REQUIRED_CAPABILITY = 'dispatch-fail-only'

const servers: Server[] = []
const homes: string[] = []

function runtimeFor(home: string, remoteResultTimeoutMs = 60_000): Runtime {
  return freshRuntime({
    home,
    model: new ScriptedModel(async request => {
      // The Worker never runs: dispatch fails before a remote turn exists.
      if (request.role !== 'worker') return { text: 'router-ok' }
      return { text: 'worker-done' }
    }),
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

function armWait(runtime: Runtime, ticketId: string, assignmentId: string): void {
  const wait = (runtime as unknown as {
    remoteResultWait?: { arm(ticketId: string, assignmentId: string): void }
  }).remoteResultWait
  wait?.arm(ticketId, assignmentId)
}

/**
 * Peer inbox that rejects every assignment with 502 after an optional gate.
 * The A2A transport maps a non-2xx response to `failed`, so the held request
 * can be released after the host has already moved on to a replacement.
 */
async function startRejectingInbox(gate: Promise<void>, onRequest: () => void): Promise<string> {
  const server = createServer((_req, res) => {
    onRequest()
    void gate.then(() => {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'delivery failed' }))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('worker bind failed')
  return `http://127.0.0.1:${address.port}/a2a`
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => {
    s.close(() => resolve())
    s.closeAllConnections()
  })))
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('Runtime remote mesh dispatch failure', () => {
  it('ends the Assignment and keeps the Ticket open when delivery fails', async () => {
    // A peer inbox that rejects every assignment with a non-2xx response. The
    // A2A transport maps that to `failed` (see a2a-http.ts), so `dispatch`
    // returns a non-delivered status and releases the mesh slot.
    const server = createServer((_req, res) => {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'delivery failed' }))
    })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('worker bind failed')
    const workerUrl = `http://127.0.0.1:${address.port}/a2a`

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-dispatch-fail-'))
    homes.push(home)
    const runtime = runtimeFor(home)
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: workerUrl,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
      capabilities: [REQUIRED_CAPABILITY],
    })
    runtime.start({ assessPending: false })

    const ticketId = createTicket(runtime, 'dispatch_fail')
    await runtime.harness.launch(loadTicket(runtime, ticketId))

    await waitFor(
      () => runtime.log.text().includes(`[mesh] remote dispatch failed ticketId=${ticketId}`),
      5_000,
      'remote dispatch to fail',
    )

    const ticket = loadTicket(runtime, ticketId)
    const assignment = ticket.assignments.at(-1)
    expect(assignment).toBeDefined()

    // The Assignment is terminal and says why: without this it would stay
    // `running` on a remote node forever, because clearing the result wait
    // means no timeout will ever report.
    expect(assignment?.state).toBe('ended')
    expect(assignment?.report?.kind).toBe('failed')
    expect(assignment?.report?.text).toContain('remote dispatch failed')
    expect(assignment?.report?.text).toContain('failed')
    expect(assignment?.report?.deliver).toBe(false)

    // A failed Assignment must not end the Ticket: a later retry stays possible.
    expect(ticket.ended).toBeUndefined()

    // The failed delivery released the remote slot and dropped the sticky
    // assignment; capacity is reusable even though the Ticket is open.
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(0)
    expect(runtime.placement.remote?.hasTicketAssignment(ticketId)).toBe(false)

    runtime.placement.release(ticketId)
    await shutdown(runtime)
  }, 60_000)

  it('keeps a live replacement Assignment and its slot when a late dispatch fails', async () => {
    let releaseDelivery!: () => void
    const deliveryGate = new Promise<void>(resolve => { releaseDelivery = resolve })
    let requested = false
    const workerUrl = await startRejectingInbox(deliveryGate, () => { requested = true })

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-dispatch-late-fail-'))
    homes.push(home)
    const runtime = runtimeFor(home)
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: workerUrl,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
      capabilities: [REQUIRED_CAPABILITY],
    })
    runtime.start({ assessPending: false })

    const ticketId = createTicket(runtime, 'late_dispatch_fail_live_replacement')
    const launch = runtime.harness.launch(loadTicket(runtime, ticketId))

    // The HTTP send is still awaiting its response. The first Assignment owns
    // the ticket's remote reservation while the dispatch is in flight.
    await waitFor(() => requested, 5_000, 'remote assignment request to arrive')
    await waitFor(
      () => runtime.placement.remote?.hasTicketAssignment(ticketId) === true,
      5_000,
      'remote slot to be reserved',
    )
    const current = loadTicket(runtime, ticketId)
    const armed = current.assignments.at(-1)!
    expect(armed.node).toBe(REMOTE_NODE_ID)
    expect(armed.state).toBe('running')
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)

    // Simulate recovery that ends the in-flight Assignment and commits a
    // replacement which already claimed the same remote node and started. The
    // sticky registry assignment deliberately stays in place: the live
    // replacement owns the reservation even though the old dispatch has not
    // returned yet.
    const replacementAssignment = {
      id: 'asg_late_failed_dispatch_replacement',
      state: 'running' as const,
      speculative: false,
      node: REMOTE_NODE_ID,
      startedAt: new Date().toISOString(),
    }
    const replacement: Ticket = {
      ...current,
      assignments: [
        { ...armed, state: 'ended', endedAt: new Date().toISOString() },
        replacementAssignment,
      ],
    }
    runtime.store.putDoc('ticket', ticketId, replacement)

    // Let the original dispatch finish as a failed delivery. Its Assignment is
    // stale, so it must not report on (or release the slot of) the replacement.
    releaseDelivery()
    await waitFor(
      () => runtime.log.text().includes(`[mesh] remote dispatch failed ticketId=${ticketId}`),
      5_000,
      'remote dispatch to fail',
    )
    await waitFor(
      () => runtime.log.text().includes(
        `[mesh] remote dispatch failed kept slot ticketId=${ticketId} assignmentId=${armed.id} replacementId=${replacementAssignment.id}`,
      ),
      5_000,
      'late failed dispatch to keep the live replacement slot',
    )
    launch.catch(() => undefined)

    const after = loadTicket(runtime, ticketId)
    const latest = after.assignments.at(-1)!
    expect(latest.id).toBe(replacementAssignment.id)
    expect(latest.state).toBe('running')
    // `Assignments.report` mutates the latest Assignment, so the failed
    // dispatch must not reach it at all.
    expect(latest.report?.text ?? '').not.toContain('remote dispatch failed')
    expect(latest.report).toBeUndefined()
    expect(after.ended).toBeUndefined()
    // The late failure must not steal the live replacement's mesh capacity.
    expect(runtime.placement.remote?.hasTicketAssignment(ticketId)).toBe(true)
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(1)

    await shutdown(runtime)
  }, 60_000)

  it('does not disarm a live replacement wait when a late dispatch fails', async () => {
    let releaseDelivery!: () => void
    const deliveryGate = new Promise<void>(resolve => { releaseDelivery = resolve })
    let requested = false
    const workerUrl = await startRejectingInbox(deliveryGate, () => { requested = true })

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-dispatch-late-fail-wait-'))
    homes.push(home)
    // Short timeout so the replacement's recovery timer fires quickly once the
    // stale failed dispatch has settled.
    const runtime = runtimeFor(home, 150)
    runtime.placement.registerRemoteNode({
      id: REMOTE_NODE_ID,
      url: workerUrl,
      peerId: WORKER_PEER,
      secret: SECRET,
      capacity: 1,
      capabilities: [REQUIRED_CAPABILITY],
    })
    runtime.start({ assessPending: false })

    const ticketId = createTicket(runtime, 'late_dispatch_fail_keeps_wait')
    const launch = runtime.harness.launch(loadTicket(runtime, ticketId))

    await waitFor(() => requested, 5_000, 'remote assignment request to arrive')
    await waitFor(
      () => runtime.placement.remote?.hasTicketAssignment(ticketId) === true,
      5_000,
      'remote slot to be reserved',
    )
    const current = loadTicket(runtime, ticketId)
    const armed = current.assignments.at(-1)!
    expect(armed.node).toBe(REMOTE_NODE_ID)
    expect(armed.state).toBe('running')

    // Commit a live replacement that already claimed the same remote node and
    // started, exactly like recovery would. The sticky slot stays reserved.
    const replacementAssignment = {
      id: 'asg_late_failed_dispatch_replacement_wait',
      state: 'running' as const,
      speculative: false,
      node: REMOTE_NODE_ID,
      startedAt: new Date().toISOString(),
    }
    const replacement: Ticket = {
      ...current,
      assignments: [
        { ...armed, state: 'ended', endedAt: new Date().toISOString() },
        replacementAssignment,
      ],
    }
    runtime.store.putDoc('ticket', ticketId, replacement)

    // The replacement has already armed its own recovery timer for this
    // ticket. `RemoteMeshResultWait` is keyed per ticketId, so the late failed
    // dispatch must not clear it while keeping the sticky slot.
    armWait(runtime, ticketId, replacementAssignment.id)

    releaseDelivery()
    await waitFor(
      () => runtime.log.text().includes(
        `[mesh] remote dispatch failed kept slot ticketId=${ticketId} assignmentId=${armed.id} replacementId=${replacementAssignment.id}`,
      ),
      5_000,
      'late failed dispatch to keep the live replacement slot',
    )
    launch.catch(() => undefined)

    // The wait survived the stale failed dispatch and timed out the hung
    // replacement instead of being silently disarmed.
    await waitFor(
      () => runtime.log.text().includes(
        `[mesh] remote result timeout ticketId=${ticketId} assignmentId=${replacementAssignment.id}`,
      ),
      // Well beyond the 150ms timeout to absorb scheduling jitter.
      5_000,
      'replacement result wait to fire',
    )

    // Recovering the hung replacement releases the sticky mesh reservation.
    await waitFor(
      () => runtime.placement.remote?.hasTicketAssignment(ticketId) === false,
      5_000,
      'mesh slot to be released after the timeout',
    )
    expect(runtime.placement.remote?.inFlight(REMOTE_NODE_ID)).toBe(0)
    const recovered = loadTicket(runtime, ticketId).assignments.find(
      item => item.id === replacementAssignment.id,
    )
    expect(recovered?.report?.text).toContain('remote worker result timeout')

    await shutdown(runtime)
  }, 60_000)
})

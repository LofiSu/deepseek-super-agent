import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { remoteResultSeen } from '../src/harness/remote-results.ts'
import type { Ticket } from '../src/shared/types.ts'
import type { Runtime } from '../src/runtime.ts'
import { freshRuntime, shutdown } from './fixtures.ts'
import { silentModel } from './scripted-model.ts'

const HOST = 'auth-host'
const NODE_A = 'remote-a'
const NODE_B = 'remote-b'
const PEER_A = 'worker-a'
const PEER_B = 'worker-b'
const SECRET = 'remote-result-auth-secret-0123456789abcdef'

const runtimes: Runtime[] = []
const homes: string[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await shutdown(runtime)
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function authRuntime(): Runtime {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-auth-'))
  homes.push(home)
  const runtime = freshRuntime({
    home,
    meshCapacity: 2,
    instanceId: HOST,
    singleSession: true,
    jobDelayMs: 0,
    env: { ...process.env, DS_AGENT_ALLOW_MOCK_FIXTURE: '1', DS_AGENT_INSTANCE_ID: HOST },
    model: silentModel(),
  })
  runtime.placement.registerRemoteNode({
    id: NODE_A,
    url: 'http://127.0.0.1:9/a2a',
    peerId: PEER_A,
    secret: SECRET,
    capacity: 1,
  })
  runtime.placement.registerRemoteNode({
    id: NODE_B,
    url: 'http://127.0.0.1:10/a2a',
    peerId: PEER_B,
    secret: SECRET,
    capacity: 1,
  })
  runtime.start({ assessPending: false })
  runtimes.push(runtime)
  return runtime
}

/** Create a ticket and place its current assignment on `node`. */
function placedTicket(runtime: Runtime, slug: string, node = NODE_A): { ticketId: string; assignmentId: string } {
  runtime.engine.receive(
    imTrigger({ id: `trg_${slug}`, thread: `topic/${slug}`, text: '@ds-agent fix checkout' }),
    { shards: ['default'] },
  )
  const ticketId = runtime.engine.evaluateDue()[0]?.ticketId ?? ''
  if (!ticketId) throw new Error('expected ticket')
  const assignmentId = runtime.store.getDoc<Ticket>('ticket', ticketId)!.assignments.at(-1)!.id
  runtime.engine.assignmentStarted(ticketId, assignmentId, `sess-${slug}`)
  runtime.engine.assignmentPlaced(ticketId, assignmentId, node)
  return { ticketId, assignmentId }
}

function result(ticketId: string, assignmentId: string, peerId: string, deliveryKey: string, text: string) {
  return {
    peerId,
    ticketId,
    assignmentId,
    report: { kind: 'ready', text, deliver: false },
    deliveryKey,
    envelope: { from: peerId, to: HOST, body: {} },
  }
}

describe('Runtime remote assignment result authorization', () => {
  it('ignores a different authenticated peer and leaves the deliveryKey for the assigned peer', () => {
    const runtime = authRuntime()
    const { ticketId, assignmentId } = placedTicket(runtime, 'peer_mismatch')
    const deliveryKey = `deliv-${ticketId}`

    runtime.applyRemoteAssignmentResult(result(ticketId, assignmentId, PEER_B, deliveryKey, 'from-worker-b'))

    expect(remoteResultSeen(runtime.store, PEER_A, deliveryKey)).toBe(false)
    expect(remoteResultSeen(runtime.store, PEER_B, deliveryKey)).toBe(false)
    expect(runtime.log.text()).toContain('reason=unauthorized-or-stale')
    const ignored = runtime.store.getDoc<Ticket>('ticket', ticketId)!
    expect(ignored.ended).toBeUndefined()
    expect(ignored.assignments.at(-1)?.report).toBeUndefined()

    // The genuine assigned peer can still use the same key.
    runtime.applyRemoteAssignmentResult(result(ticketId, assignmentId, PEER_A, deliveryKey, 'from-worker-a'))

    expect(remoteResultSeen(runtime.store, PEER_A, deliveryKey)).toBe(true)
    const applied = runtime.store.getDoc<Ticket>('ticket', ticketId)!
    expect(applied.ended).toBeDefined()
    expect(applied.assignments.at(-1)?.report?.text).toBe('from-worker-a')
  })

  it('ignores a stale assignmentId from the correct peer without consuming the key', () => {
    const runtime = authRuntime()
    const { ticketId, assignmentId } = placedTicket(runtime, 'stale_assignment')
    const deliveryKey = `deliv-${ticketId}`

    runtime.applyRemoteAssignmentResult(result(ticketId, 'asg_stale', PEER_A, deliveryKey, 'stale'))

    expect(remoteResultSeen(runtime.store, PEER_A, deliveryKey)).toBe(false)
    expect(runtime.log.text()).toContain('reason=unauthorized-or-stale')
    expect(runtime.log.text()).toContain('detail=stale-assignment')
    const ignored = runtime.store.getDoc<Ticket>('ticket', ticketId)!
    expect(ignored.ended).toBeUndefined()
    expect(ignored.assignments.at(-1)?.report).toBeUndefined()

    runtime.applyRemoteAssignmentResult(result(ticketId, assignmentId, PEER_A, deliveryKey, 'current'))

    expect(remoteResultSeen(runtime.store, PEER_A, deliveryKey)).toBe(true)
    expect(runtime.store.getDoc<Ticket>('ticket', ticketId)?.assignments.at(-1)?.report?.text).toBe('current')
  })

  it('ignores a result for a local assignment and for an unknown ticket', () => {
    const runtime = authRuntime()
    const { ticketId, assignmentId } = placedTicket(runtime, 'local_owner', HOST)

    runtime.applyRemoteAssignmentResult(result(ticketId, assignmentId, PEER_A, 'deliv-local', 'from-peer'))

    expect(remoteResultSeen(runtime.store, PEER_A, 'deliv-local')).toBe(false)
    expect(runtime.log.text()).toContain('detail=not-remote')
    expect(runtime.store.getDoc<Ticket>('ticket', ticketId)?.ended).toBeUndefined()

    runtime.applyRemoteAssignmentResult(result('ticket_missing', 'asg_missing', PEER_A, 'deliv-missing', 'ghost'))

    expect(remoteResultSeen(runtime.store, PEER_A, 'deliv-missing')).toBe(false)
    expect(runtime.log.text()).toContain('detail=missing-ticket')
  })

  it('scopes deliveryKey idempotence by peerId so two authorized peers can share a key', () => {
    const runtime = authRuntime()
    const a = placedTicket(runtime, 'shared_key_a', NODE_A)
    const b = placedTicket(runtime, 'shared_key_b', NODE_B)
    const deliveryKey = 'shared-delivery-key'

    // Peer A applies its genuine result for ticket A under the shared key.
    runtime.applyRemoteAssignmentResult(result(a.ticketId, a.assignmentId, PEER_A, deliveryKey, 'from-worker-a'))

    expect(remoteResultSeen(runtime.store, PEER_A, deliveryKey)).toBe(true)
    expect(remoteResultSeen(runtime.store, PEER_B, deliveryKey)).toBe(false)
    expect(runtime.store.getDoc<Ticket>('ticket', a.ticketId)?.assignments.at(-1)?.report?.text).toBe('from-worker-a')

    // Peer B's authorized result for a different ticket uses the same wire key
    // and must still apply: idempotence is scoped per peer now.
    runtime.applyRemoteAssignmentResult(result(b.ticketId, b.assignmentId, PEER_B, deliveryKey, 'from-worker-b'))

    expect(remoteResultSeen(runtime.store, PEER_B, deliveryKey)).toBe(true)
    expect(runtime.store.getDoc<Ticket>('ticket', b.ticketId)?.assignments.at(-1)?.report?.text).toBe('from-worker-b')
    expect(runtime.store.getDoc<Ticket>('ticket', a.ticketId)?.assignments.at(-1)?.report?.text).toBe('from-worker-a')
    expect(runtime.log.text()).not.toContain('remote result duplicate deliveryKey')

    // The same peer replaying the same key is still a duplicate and must not
    // overwrite the applied report.
    runtime.applyRemoteAssignmentResult(result(b.ticketId, b.assignmentId, PEER_B, deliveryKey, 'rewritten'))

    expect(runtime.log.text()).toContain('remote result duplicate deliveryKey')
    expect(runtime.store.getDoc<Ticket>('ticket', b.ticketId)?.assignments.at(-1)?.report?.text).toBe('from-worker-b')
  })
})

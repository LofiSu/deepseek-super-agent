import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { remoteResultSeen } from '../src/harness/remote-results.ts'
import type { Runtime } from '../src/runtime.ts'
import type { Ticket } from '../src/shared/types.ts'
import { freshRuntime, shutdown } from './fixtures.ts'
import { silentModel } from './scripted-model.ts'

const HOST = 'ended-host'
const REMOTE_NODE_ID = 'ended-remote-node'
const WORKER_PEER = 'worker'
const SECRET = 'ended-assignment-secret-0123456789abcdef'

const runtimes: Runtime[] = []
const homes: string[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await shutdown(runtime)
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function placedRuntime(): { runtime: Runtime; ticketId: string; assignmentId: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-ended-'))
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
    id: REMOTE_NODE_ID,
    url: 'http://127.0.0.1:9/a2a',
    peerId: WORKER_PEER,
    secret: SECRET,
    capacity: 1,
  })
  runtime.start({ assessPending: false })
  runtimes.push(runtime)

  runtime.engine.receive(
    imTrigger({ id: 'trg_ended', thread: 'topic/trg_ended', text: '@ds-agent fix the checkout timeout' }),
    { shards: ['default'] },
  )
  const ticketId = runtime.engine.evaluateDue()[0]?.ticketId ?? ''
  if (!ticketId) throw new Error('expected ticket')
  const assignmentId = runtime.store.getDoc<Ticket>('ticket', ticketId)!.assignments.at(-1)!.id
  runtime.engine.assignmentStarted(ticketId, assignmentId, `sess-${ticketId}`)
  runtime.engine.assignmentPlaced(ticketId, assignmentId, REMOTE_NODE_ID)
  return { runtime, ticketId, assignmentId }
}

describe('Runtime remote result after assignment end', () => {
  it('ignores a late result for an ended assignment while the ticket stays open', () => {
    const { runtime, ticketId, assignmentId } = placedRuntime()

    // The remote result wait timed out: the Assignment ends but the Ticket stays
    // open so a later Assignment can retry the work.
    runtime.engine.report(ticketId, {
      kind: 'failed',
      text: 'remote worker result timeout',
      deliver: false,
    })
    const timedOut = runtime.store.getDoc<Ticket>('ticket', ticketId)!
    expect(timedOut.ended).toBeUndefined()
    expect(timedOut.assignments.at(-1)?.state).toBe('ended')
    expect(timedOut.assignments.at(-1)?.report?.text).toBe('remote worker result timeout')

    const deliveryKey = `deliv-ended-${ticketId}`
    runtime.applyRemoteAssignmentResult({
      peerId: WORKER_PEER,
      ticketId,
      assignmentId,
      report: { kind: 'ready', text: 'late-ready', deliver: true },
      deliveryKey,
      envelope: { from: WORKER_PEER, to: HOST, body: {} },
    })

    // The result is rejected before recordRemoteResult: no key consumed, no
    // report overwrite, and no ticket end.
    expect(remoteResultSeen(runtime.store, deliveryKey)).toBe(false)
    expect(runtime.log.text()).toContain('reason=ended-assignment')
    const after = runtime.store.getDoc<Ticket>('ticket', ticketId)!
    expect(after.ended).toBeUndefined()
    expect(after.assignments.at(-1)?.report?.text).toBe('remote worker result timeout')
  })

  it('still applies an authorized result for a live assignment', () => {
    const { runtime, ticketId, assignmentId } = placedRuntime()
    const deliveryKey = `deliv-live-${ticketId}`

    runtime.applyRemoteAssignmentResult({
      peerId: WORKER_PEER,
      ticketId,
      assignmentId,
      report: { kind: 'ready', text: 'live-result', deliver: false },
      deliveryKey,
      envelope: { from: WORKER_PEER, to: HOST, body: {} },
    })

    expect(remoteResultSeen(runtime.store, deliveryKey)).toBe(true)
    expect(runtime.store.getDoc<Ticket>('ticket', ticketId)?.assignments.at(-1)?.report?.text).toBe('live-result')
    expect(runtime.store.getDoc<Ticket>('ticket', ticketId)?.ended).toBeDefined()
  })
})

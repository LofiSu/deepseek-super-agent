import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { remoteResultSeen } from '../src/harness/remote-results.ts'
import type { Ticket } from '../src/shared/types.ts'
import type { Runtime } from '../src/runtime.ts'
import { freshRuntime, shutdown } from './fixtures.ts'
import { silentModel } from './scripted-model.ts'

const HOST = 'atomic-host'
const NODE_A = 'remote-a'
const PEER_A = 'worker-a'
const SECRET = 'remote-result-atomic-secret-0123456789abcdef'

const runtimes: Runtime[] = []
const homes: string[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await shutdown(runtime)
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function atomicRuntime(): Runtime {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-atomic-'))
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
  runtime.start({ assessPending: false })
  runtimes.push(runtime)
  return runtime
}

/** Create a ticket and place its current assignment on the remote node. */
function placedTicket(runtime: Runtime, slug: string): { ticketId: string; assignmentId: string } {
  runtime.engine.receive(
    imTrigger({ id: `trg_${slug}`, thread: `topic/${slug}`, text: '@ds-agent fix checkout' }),
    { shards: ['default'] },
  )
  const ticketId = runtime.engine.evaluateDue()[0]?.ticketId ?? ''
  if (!ticketId) throw new Error('expected ticket')
  const assignmentId = runtime.store.getDoc<Ticket>('ticket', ticketId)!.assignments.at(-1)!.id
  runtime.engine.assignmentStarted(ticketId, assignmentId, `sess-${slug}`)
  runtime.engine.assignmentPlaced(ticketId, assignmentId, NODE_A)
  return { ticketId, assignmentId }
}

function result(ticketId: string, assignmentId: string, deliveryKey: string, text: string) {
  return {
    peerId: PEER_A,
    ticketId,
    assignmentId,
    report: { kind: 'ready', text, deliver: false },
    deliveryKey,
    envelope: { from: PEER_A, to: HOST, body: {} },
  }
}

describe('Runtime remote result report atomicity', () => {
  it('does not consume the deliveryKey when engine.report throws, and a retry applies', () => {
    const runtime = atomicRuntime()
    const { ticketId, assignmentId } = placedTicket(runtime, 'report_throw')
    const deliveryKey = `deliv-${ticketId}`

    const reportSpy = vi.spyOn(runtime.engine, 'report').mockImplementationOnce(() => {
      throw new Error('report blew up')
    })

    expect(() => runtime.applyRemoteAssignmentResult(result(ticketId, assignmentId, deliveryKey, 'first')))
      .toThrow('report blew up')

    // Fail-before (cebfd4c): the deliveryKey was recorded *before* engine.report,
    // so this assertion was `true` and the retry below was dropped as a duplicate
    // with no report ever landing. The key must stay unwritten until it lands.
    expect(remoteResultSeen(runtime.store, PEER_A, deliveryKey)).toBe(false)
    const interrupted = runtime.store.getDoc<Ticket>('ticket', ticketId)!
    expect(interrupted.ended).toBeUndefined()
    expect(interrupted.assignments.at(-1)?.state).not.toBe('ended')
    expect(interrupted.assignments.at(-1)?.report).toBeUndefined()

    reportSpy.mockRestore()

    runtime.applyRemoteAssignmentResult(result(ticketId, assignmentId, deliveryKey, 'second'))

    expect(remoteResultSeen(runtime.store, PEER_A, deliveryKey)).toBe(true)
    expect(runtime.log.text()).not.toContain('remote result duplicate deliveryKey')
    const applied = runtime.store.getDoc<Ticket>('ticket', ticketId)!
    expect(applied.ended).toBeDefined()
    expect(applied.assignments.at(-1)?.report?.text).toBe('second')
  })

  it('still archives a result for an already-ended ticket without reporting again', () => {
    const runtime = atomicRuntime()
    const { ticketId, assignmentId } = placedTicket(runtime, 'ended_archive')
    runtime.engine.report(ticketId, { kind: 'ready', text: 'done locally', deliver: false })
    expect(runtime.store.getDoc<Ticket>('ticket', ticketId)?.ended).toBeDefined()

    const reportSpy = vi.spyOn(runtime.engine, 'report')
    const deliveryKey = `deliv-ended-${ticketId}`
    runtime.applyRemoteAssignmentResult(result(ticketId, assignmentId, deliveryKey, 'late'))
    expect(reportSpy).not.toHaveBeenCalled()
    reportSpy.mockRestore()

    expect(remoteResultSeen(runtime.store, PEER_A, deliveryKey)).toBe(true)
    expect(runtime.store.getDoc<Ticket>('ticket', ticketId)?.assignments.at(-1)?.report?.text).toBe('done locally')
  })
})

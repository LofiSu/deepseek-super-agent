import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { recordRemoteResult, remoteResultSeen } from '../src/harness/remote-results.ts'
import type { WorkerReport } from '../src/shared/ports.ts'
import type { Ticket } from '../src/shared/types.ts'
import { freshRuntime, shutdown } from './fixtures.ts'
import { silentModel } from './scripted-model.ts'

const HOST = 'cancel-host'
const REMOTE_NODE_ID = 'cancel-remote-node'
const WORKER_PEER = 'worker'
const SECRET = 'cancel-remote-result-secret-0123456789abcdef'

describe('Runtime remote result idempotence after cancel', () => {
  it('is idempotent and records after ticket end for the assigned remote peer', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-'))
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
    runtime.engine.receive(
      imTrigger({ id: 'trg_done', thread: 'topic/trg_done', text: '@ds-agent fix the login timeout on checkout' }),
      { shards: ['default'] },
    )
    const ticketId = runtime.engine.evaluateDue()[0]?.ticketId ?? ''
    expect(ticketId).toBeTruthy()
    const assignmentId = runtime.store.getDoc<Ticket>('ticket', ticketId)!.assignments.at(-1)!.id
    // The Harness chose this registered remote node for the ticket, and the
    // ticket then ended (cancel) before the worker's result arrived.
    runtime.engine.assignmentStarted(ticketId, assignmentId, `sess-${ticketId}`)
    runtime.engine.assignmentPlaced(ticketId, assignmentId, REMOTE_NODE_ID)
    runtime.engine.report(ticketId, { kind: 'ready', text: 'done locally', deliver: false })
    expect(runtime.store.getDoc<Ticket>('ticket', ticketId)?.ended).toBeDefined()

    const report: WorkerReport = { kind: 'ready', text: 'late remote', deliver: false }
    const deliveryKey = `deliv-cancel-${ticketId}`
    // Simulate a result that was already accepted before the cancel.
    recordRemoteResult(runtime.store, { ticketId, assignmentId, report, deliveryKey })

    runtime.applyRemoteAssignmentResult({
      peerId: WORKER_PEER,
      ticketId,
      assignmentId,
      report,
      deliveryKey,
      envelope: { from: WORKER_PEER, to: HOST, body: {} },
    })
    expect(runtime.log.text()).toContain('remote result duplicate deliveryKey')

    const lateKey = `deliv-cancel-${ticketId}-late`
    runtime.applyRemoteAssignmentResult({
      peerId: WORKER_PEER,
      ticketId,
      assignmentId,
      report: { kind: 'ready', text: 'after end', deliver: false },
      deliveryKey: lateKey,
      envelope: { from: WORKER_PEER, to: HOST, body: {} },
    })
    expect(runtime.log.text()).toContain('remote result after ticket end')
    // The authorized late result is recorded for idempotency without rewriting
    // the already-ended ticket.
    expect(remoteResultSeen(runtime.store, lateKey)).toBe(true)
    const after = runtime.store.getDoc<Ticket>('ticket', ticketId)!
    expect(after.ended).toBeDefined()
    expect(after.assignments.at(-1)?.report?.text).toBe('done locally')

    await shutdown(runtime)
    fs.rmSync(home, { recursive: true, force: true })
  })
})

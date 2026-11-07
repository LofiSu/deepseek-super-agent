import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { recordRemoteResult } from '../src/harness/remote-results.ts'
import type { WorkerReport } from '../src/shared/ports.ts'
import type { Ticket } from '../src/shared/types.ts'
import { freshRuntime, shutdown } from './fixtures.ts'
import { field, lastPrompt, ScriptedModel } from './scripted-model.ts'

const HOST = 'cancel-host'

describe('Runtime remote result idempotence after cancel', () => {
  it('applyRemoteAssignmentResult is idempotent and no-ops when ticket already ended', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mesh-cancel-'))
    const runtime = freshRuntime({
      home,
      meshCapacity: 2,
      instanceId: HOST,
      singleSession: true,
      jobDelayMs: 0,
      env: { ...process.env, DS_AGENT_ALLOW_MOCK_FIXTURE: '1', DS_AGENT_INSTANCE_ID: HOST },
      model: new ScriptedModel(async request => {
        if (request.role !== 'worker') return { text: 'ok' }
        const ticketId = field(lastPrompt(request), 'ticketId')
        const reported = request.messages.some(m => m.role === 'tool' && m.name === 'report_to_router')
        if (!reported) {
          return {
            toolCalls: [{
              id: 'r1',
              name: 'report_to_router',
              args: { ticketId, text: 'ready: ok', deliver: false, kind: 'ready' },
            }],
          }
        }
        return { text: 'done' }
      }),
    })
    runtime.start({ assessPending: false })
    runtime.engine.receive(
      imTrigger({ id: 'trg_done', thread: 'topic/trg_done', text: '@ds-agent fix the login timeout on checkout' }),
      { shards: ['default'] },
    )
    const ticketId = runtime.engine.evaluateDue()[0]?.ticketId ?? ''
    expect(ticketId).toBeTruthy()
    await runtime.harness.launch(runtime.store.getDoc<Ticket>('ticket', ticketId)!)
    await runtime.jobsSettled()
    expect(runtime.store.getDoc<Ticket>('ticket', ticketId)?.ended).toBeDefined()

    const assignmentId = runtime.store.getDoc<Ticket>('ticket', ticketId)!.assignments.at(-1)!.id
    const report: WorkerReport = { kind: 'ready', text: 'late remote', deliver: false }
    const deliveryKey = `deliv-cancel-${ticketId}`
    recordRemoteResult(runtime.store, { ticketId, assignmentId, report, deliveryKey })

    runtime.applyRemoteAssignmentResult({
      peerId: 'worker',
      ticketId,
      assignmentId,
      report,
      deliveryKey,
      envelope: { from: 'worker', to: HOST, body: {} },
    })
    expect(runtime.log.text()).toContain('remote result duplicate deliveryKey')

    runtime.applyRemoteAssignmentResult({
      peerId: 'worker',
      ticketId,
      assignmentId,
      report: { kind: 'ready', text: 'after end', deliver: false },
      deliveryKey: `deliv-cancel-${ticketId}-late`,
      envelope: { from: 'worker', to: HOST, body: {} },
    })
    expect(runtime.log.text()).toContain('remote result after ticket end')
    await shutdown(runtime)
    fs.rmSync(home, { recursive: true, force: true })
  })
})

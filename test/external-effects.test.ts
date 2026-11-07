import { describe, expect, it } from 'vitest'
import {
  beginDelegateOperation,
  blocksRestartRecovery,
  EXTERNAL_OP_KIND,
  finalizeUncertainExternalEffects,
  finishOutboxSendOperation,
  recordOutboxSendStart,
  type ExternalOperationRecord,
} from '../src/core/external-effects.ts'
import type { Ticket } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'
import { tempHome } from './fixtures.ts'

describe('external-effects lifecycle', () => {
  it('finalize marks started delegate ops unknown and blocks restart recovery', () => {
    const home = tempHome()
    const store = new Store(home)
    try {
      const at = new Date().toISOString()
      const ticket: Ticket = {
        id: 'ticket_x',
        title: 't',
        brief: 'b',
        mandate: {
          strength: 'explicit',
          policyVersion: 'p',
          scope: 's',
          actor: { source: 'cli', id: 'u' },
          basis: 'addressed',
        },
        threadKeys: ['cli:x'],
        channels: [],
        inputs: [],
        assignments: [{ id: 'asg_1', state: 'running', speculative: false, startedAt: at }],
        speculative: false,
        originTriggerId: 'trg',
        createdAt: at,
      }
      store.putDoc('ticket', ticket.id, ticket)
      beginDelegateOperation({
        store,
        ticketId: ticket.id,
        assignmentId: 'asg_1',
        sessionId: 'worker_x',
        agent: 'a',
        task: 'do',
        now: at,
      })
      const now = new Date().toISOString()
      const summary = finalizeUncertainExternalEffects(store, now)
      expect(summary.unknownOps).toBe(1)
      expect(summary.approvalsQueued).toBe(1)
      const saved = store.getDoc<Ticket>('ticket', ticket.id)!
      expect(saved.collab?.approvals?.[0]?.status).toBe('pending')
      const ops = store.listDocs<ExternalOperationRecord>(EXTERNAL_OP_KIND)
      expect(ops[0]?.phase).toBe('unknown_outcome')
      expect(blocksRestartRecovery(saved, store)).toBe(true)
    } finally {
      store.close()
    }
  })

  it('successful outbox send completes external_op so restart does not mark unknown', () => {
    const home = tempHome()
    const store = new Store(home)
    try {
      const at = new Date().toISOString()
      const row = {
        id: 'obx_1',
        ticketId: 'ticket_y',
        channel: 'im',
        status: 'pending' as const,
        replyId: 'rpl_1',
        thread: 'feishu:t',
        target: { provider: 'feishu', chat_id: 't' },
        text: 'hi',
        idempotencyKey: 'idem_1',
        createdAt: at,
      }
      store.enqueueOutbox(row)
      store.claimOutbox(row.id)
      recordOutboxSendStart(store, row, at)
      finishOutboxSendOperation(store, row, 'completed', at, 'ext_99')
      const summary = finalizeUncertainExternalEffects(store, at)
      expect(summary.unknownOps).toBe(0)
      const op = store.getDoc<ExternalOperationRecord>(EXTERNAL_OP_KIND, `outbox_${row.id}`)
      expect(op?.phase).toBe('completed')
    } finally {
      store.close()
    }
  })
})

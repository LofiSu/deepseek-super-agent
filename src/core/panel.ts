import path from 'node:path'
import { visibleTickets } from '../speculate/index.ts'
import type { OutboxRow, Ticket } from '../shared/types.ts'
import type { Store } from '../store/sqlite.ts'
import { executionState, type ExecutionState } from './stage.ts'

/**
 * Read-only Panel view. It is derived from Store facts, never from a model's
 * last sentence. `Execution` is the Ticket page inside Panel.
 */
export interface ExecutionRow {
  ticketId: string
  title: string
  state: ExecutionState
  mandate: Ticket['mandate']
  executorSession?: string
  directory?: string
  lastReport?: Ticket['assignments'][number]['report']
  threadKeys: string[]
  contextOnlyThreads: string[]
  pendingInputs: number
  outbox: { pending: number; sent: number; failed: number }
}

const ATTENTION: Record<ExecutionState, number> = {
  'awaiting-answer': 0,
  'awaiting-review': 1,
  blocked: 2,
  working: 3,
  pending: 4,
  'waiting-for-trigger': 5,
  open: 6,
  ended: 7,
}

export function executionView(store: Store, home?: string): ExecutionRow[] {
  const outbox = store.listOutbox()
  return visibleTickets(store.listDocs<Ticket>('ticket'))
    .map(ticket => {
      const assignment = ticket.assignments.at(-1)
      const sessionId = assignment?.workerSessionId
      const rows = outbox.filter(row => row.ticketId === ticket.id)
      return {
        ticketId: ticket.id,
        title: ticket.title,
        state: executionState(ticket),
        mandate: ticket.mandate,
        executorSession: sessionId,
        directory: sessionId && home ? path.join(home, 'workspaces', sessionId) : undefined,
        lastReport: assignment?.report,
        threadKeys: ticket.threadKeys,
        contextOnlyThreads: ticket.contextOnlyThreads ?? [],
        pendingInputs: ticket.inputs.length,
        outbox: countOutbox(rows),
      }
    })
    .sort((left, right) => {
      const rank = ATTENTION[left.state] - ATTENTION[right.state]
      return rank !== 0 ? rank : left.ticketId.localeCompare(right.ticketId)
    })
}

function countOutbox(rows: OutboxRow[]): ExecutionRow['outbox'] {
  const counted = { pending: 0, sent: 0, failed: 0 }
  for (const row of rows) {
    if (row.status === 'sent') counted.sent += 1
    else if (row.status === 'failed') counted.failed += 1
    else counted.pending += 1
  }
  return counted
}

export function formatExecution(rows: ExecutionRow[]): string {
  if (rows.length === 0) return 'panel: no tickets'
  const lines = ['Panel · Execution']
  for (const row of rows) {
    lines.push(`${row.ticketId}\t${row.state}\t${row.title}`)
    lines.push(`  mandate: ${row.mandate.scope} (${row.mandate.strength}, ${row.mandate.policyVersion})`)
    if (row.executorSession) lines.push(`  executor: ${row.executorSession}`)
    if (row.directory) lines.push(`  directory: ${row.directory}`)
    if (row.lastReport) lines.push(`  report: ${row.lastReport.kind} — ${row.lastReport.text}`)
    if (row.threadKeys.length > 0) {
      const context = row.contextOnlyThreads.length > 0
        ? ` (context-only: ${row.contextOnlyThreads.join(', ')})`
        : ''
      lines.push(`  subscriptions: ${row.threadKeys.join(', ')}${context}`)
    }
    const delivery = row.outbox
    lines.push(`  outbox: pending=${delivery.pending} sent=${delivery.sent} failed=${delivery.failed}`)
  }
  return lines.join('\n')
}

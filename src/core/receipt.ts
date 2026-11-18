import type { ExternalOperationRecord } from './external-effects.ts'
import { EXTERNAL_OP_KIND } from './external-effects.ts'
import type { ReplyRow, Ticket } from '../shared/types.ts'
import type { Store } from '../store/sqlite.ts'

export type ReceiptStatus = 'success' | 'failed' | 'unknown'
export type ReceiptDeliveryStatus = ReceiptStatus | 'none'

export interface ExecutionReceipt {
  schemaVersion: 1
  ticketId: string
  status: ReceiptStatus
  createdAt?: string
  endedAt?: string
  terminalOutcome?: 'ready' | 'failed' | 'dropped' | 'discarded' | 'stopped' | 'other'
  channels: string[]
  inputs: Array<{ id: string; kind: 'trigger' | 'text' | 'job' | 'context' | 'other'; at?: string }>
  assignments: Array<{
    id: string
    state: 'pending' | 'running' | 'ended' | 'other'
    startedAt?: string
    endedAt?: string
    reportKind?: 'ready' | 'failed' | 'blocked' | 'waiting' | 'dropped' | 'progress' | 'stopped' | 'other'
    reportAt?: string
  }>
  delivery: {
    status: ReceiptDeliveryStatus
    items: Array<{
      id: string
      channel: string
      status: ReceiptDeliveryStatus
      at?: string
    }>
  }
  trackedExternalEffects: Array<{
    id: string
    kind: 'delegate_agent' | 'other'
    status: ReceiptStatus
    assignmentId?: string
    updatedAt?: string
  }>
  scope: {
    evidence: string[]
    limitation: string
  }
}

const INPUT_KINDS = new Set(['trigger', 'text', 'job', 'context'])
const ASSIGNMENT_STATES = new Set(['pending', 'running', 'ended'])
const REPORT_KINDS = new Set(['ready', 'failed', 'blocked', 'waiting', 'dropped', 'progress', 'stopped'])
const TICKET_OUTCOMES = new Set(['ready', 'failed', 'dropped', 'discarded', 'stopped'])
const DELIVERY_STATES = new Set(['pending', 'sending', 'unknown_outcome', 'sent', 'failed', 'dropped'])
const OP_PHASES = new Set([
  'started', 'completed', 'failed', 'unknown_outcome', 'operator_released', 'operator_acknowledged',
])
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/
const SAFE_CHANNELS = new Set(['a2a', 'cli', 'github', 'im', 'imessage'])
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

/**
 * Build a read-only receipt from persisted facts for one Ticket. Bodies,
 * destinations, raw errors, operation details, and external ids are deliberately
 * omitted: this view is for evidence, not replay or model context.
 */
export function executionReceipt(store: Store, ticket: Ticket): ExecutionReceipt {
  const ticketId = safeId(ticket.id)
  const replies = store.listReceiptReplies(ticket.id)
  const outbox = store.listReceiptOutbox(ticket.id)
  const operations = store.listDocsForTicket<ExternalOperationRecord>(EXTERNAL_OP_KIND, ticket.id)
    .filter(record => record.kind !== 'outbox_send')

  const deliveryItems: ExecutionReceipt['delivery']['items'] = [
    ...replies
      .filter(row => row.channel === 'cli')
      .map(row => ({
        id: safeId(row.id),
        channel: 'cli',
        status: replyStatus(row),
        ...(safeTimestamp(row.createdAt) ? { at: safeTimestamp(row.createdAt) } : {}),
      })),
    ...outbox.map(row => ({
      id: safeId(row.id),
      channel: safeChannel(row.channel),
      status: deliveryStatus(row.status),
      ...(safeTimestamp(row.sentAt ?? row.createdAt)
        ? { at: safeTimestamp(row.sentAt ?? row.createdAt) }
        : {}),
    })),
  ]
  const executionStatus = statusForTicket(ticket)
  const trackedExternalEffects = operations.map(operation => ({
    id: safeId(operation.id),
    kind: operation.kind === 'delegate_agent' ? 'delegate_agent' as const : 'other' as const,
    status: operationStatus(operation.phase),
    ...(operation.assignmentId ? { assignmentId: safeId(operation.assignmentId) } : {}),
    ...(safeTimestamp(operation.updatedAt) ? { updatedAt: safeTimestamp(operation.updatedAt) } : {}),
  }))

  return {
    schemaVersion: 1,
    ticketId,
    status: executionStatus,
    ...(safeTimestamp(ticket.createdAt) ? { createdAt: safeTimestamp(ticket.createdAt) } : {}),
    ...(safeTimestamp(ticket.ended?.at) ? { endedAt: safeTimestamp(ticket.ended?.at) } : {}),
    ...(ticket.ended ? { terminalOutcome: safeOutcome(ticket.ended.outcome) } : {}),
    channels: [...new Set(ticket.channels.map(channel => safeChannel(channel.source)))].sort(),
    inputs: ticket.inputs.map(input => ({
      id: safeId(input.id),
      kind: INPUT_KINDS.has(input.kind) ? input.kind : 'other',
      ...(safeTimestamp(input.at) ? { at: safeTimestamp(input.at) } : {}),
    })),
    assignments: ticket.assignments.map(assignment => ({
      id: safeId(assignment.id),
      state: ASSIGNMENT_STATES.has(assignment.state) ? assignment.state : 'other',
      ...(safeTimestamp(assignment.startedAt) ? { startedAt: safeTimestamp(assignment.startedAt) } : {}),
      ...(safeTimestamp(assignment.endedAt) ? { endedAt: safeTimestamp(assignment.endedAt) } : {}),
      ...(assignment.report ? { reportKind: safeReportKind(assignment.report.kind) } : {}),
      ...(safeTimestamp(assignment.report?.at) ? { reportAt: safeTimestamp(assignment.report?.at) } : {}),
    })),
    delivery: {
      status: aggregateDelivery(deliveryItems),
      items: deliveryItems,
    },
    trackedExternalEffects,
    scope: {
      evidence: [
        'persisted ticket inputs and assignments',
        'local CLI replies and durable outbound queue rows',
        'tracked external-operation records (excluding outbound rows shown above)',
      ],
      limitation: 'Input and reply bodies, destinations, raw errors, and credentials are omitted. This receipt cannot prove arbitrary model/tool reads or uninstrumented effects; absence means no matching record was persisted, not that nothing happened.',
    },
  }
}

export function formatExecutionReceipt(receipt: ExecutionReceipt): string {
  const lines = [
    'ds-agent execution receipt',
    `ticket: ${receipt.ticketId}`,
    `status: ${receipt.status}`,
    `created: ${receipt.createdAt ?? 'unknown'}`,
    `ended: ${receipt.endedAt ?? 'not recorded'}`,
    `terminal outcome: ${receipt.terminalOutcome ?? 'not recorded'}`,
    `input records: ${receipt.inputs.length} (${receipt.inputs.map(input => input.kind).join(', ') || 'none'})`,
    `input channels: ${receipt.channels.join(', ') || 'none recorded'}`,
    'assignments:',
  ]
  if (receipt.assignments.length === 0) lines.push('  none recorded')
  for (const assignment of receipt.assignments) {
    lines.push(
      `  ${assignment.id} state=${assignment.state}`
      + `${assignment.reportKind ? ` report=${assignment.reportKind}` : ''}`
      + `${assignment.startedAt ? ` started=${assignment.startedAt}` : ''}`
      + `${assignment.endedAt ? ` ended=${assignment.endedAt}` : ''}`,
    )
  }
  lines.push(`delivery: ${receipt.delivery.status}`)
  if (receipt.delivery.items.length === 0) lines.push('  no delivery record')
  for (const item of receipt.delivery.items) {
    lines.push(`  ${item.id} channel=${item.channel} status=${item.status}${item.at ? ` at=${item.at}` : ''}`)
  }
  lines.push('tracked external effects:')
  if (receipt.trackedExternalEffects.length === 0) lines.push('  none recorded')
  for (const effect of receipt.trackedExternalEffects) {
    lines.push(
      `  ${effect.id} kind=${effect.kind} status=${effect.status}`
      + `${effect.assignmentId ? ` assignment=${effect.assignmentId}` : ''}`
      + `${effect.updatedAt ? ` updated=${effect.updatedAt}` : ''}`,
    )
  }
  lines.push(`scope: ${receipt.scope.limitation}`)
  return lines.join('\n')
}

function statusForTicket(ticket: Ticket): ReceiptStatus {
  const latest = ticket.assignments.at(-1)
  if (latest?.report?.kind === 'failed' || ticket.ended?.outcome === 'failed') return 'failed'
  if (
    ticket.ended?.by === 'executor'
    && ticket.ended.outcome === 'ready'
    && latest?.state === 'ended'
  ) return 'success'
  return 'unknown'
}

function aggregateDelivery(items: ExecutionReceipt['delivery']['items']): ReceiptDeliveryStatus {
  const attempted = items.filter(item => item.status !== 'none')
  if (attempted.length === 0) return 'none'
  if (attempted.some(item => item.status === 'failed')) return 'failed'
  if (attempted.some(item => item.status === 'unknown')) return 'unknown'
  return 'success'
}

function replyStatus(row: Pick<ReplyRow, 'status'>): ReceiptDeliveryStatus {
  if (row.status === 'sent') return 'success'
  if (row.status === 'dropped') return 'none'
  return 'unknown'
}

function deliveryStatus(status: string): ReceiptDeliveryStatus {
  if (!DELIVERY_STATES.has(status)) return 'unknown'
  if (status === 'sent') return 'success'
  if (status === 'failed') return 'failed'
  if (status === 'dropped') return 'none'
  return 'unknown'
}

function operationStatus(phase: string): ReceiptStatus {
  if (phase === 'completed') return 'success'
  if (phase === 'failed') return 'failed'
  if (OP_PHASES.has(phase)) return 'unknown'
  return 'unknown'
}

function safeReportKind(kind: string): NonNullable<ExecutionReceipt['assignments'][number]['reportKind']> {
  return REPORT_KINDS.has(kind) ? kind as NonNullable<ExecutionReceipt['assignments'][number]['reportKind']> : 'other'
}

function safeOutcome(outcome: string): NonNullable<ExecutionReceipt['terminalOutcome']> {
  return TICKET_OUTCOMES.has(outcome) ? outcome as NonNullable<ExecutionReceipt['terminalOutcome']> : 'other'
}

function safeId(value: string): string {
  return SAFE_ID.test(value) ? value : '[redacted-id]'
}

function safeChannel(value: string): string {
  return SAFE_CHANNELS.has(value) ? value : 'other'
}

function safeTimestamp(value: unknown): string | undefined {
  return typeof value === 'string'
    && ISO_TIMESTAMP.test(value)
    && Number.isFinite(Date.parse(value))
    ? value
    : undefined
}

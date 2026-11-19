import { createHash } from 'node:crypto'
import type { OutboxRow, Ticket } from '../shared/types.ts'
import type { Store } from '../store/sqlite.ts'
import type { ApprovalRequest } from '../shared/types.ts'
import { approvalActionId, ensureCollaboration, pendingApproval } from './collab.ts'

export const EXTERNAL_OP_KIND = 'external_op'
export const UNKNOWN_OUTCOME_PREFIX = 'UNKNOWN-OUTCOME:'

export type ExternalOperationKind = 'delegate_agent' | 'outbox_send'

export type ExternalOperationPhase =
  | 'started'
  | 'completed'
  | 'failed'
  | 'unknown_outcome'
  | 'operator_released'
  | 'operator_acknowledged'

/** Persisted delegation / outbound lifecycle for crash-boundary honesty. */
export interface ExternalOperationRecord {
  schemaVersion: 1
  id: string
  kind: ExternalOperationKind
  ticketId: string
  assignmentId?: string
  sessionId?: string
  idempotencyKey: string
  phase: ExternalOperationPhase
  startedAt: string
  updatedAt: string
  detail?: string
}

export function delegateIdempotencyKey(
  ticketId: string,
  assignmentId: string,
  agent: string,
  task: string,
): string {
  const digest = createHash('sha256').update(`${agent}\0${task}`).digest('hex').slice(0, 16)
  return `delegate:${ticketId}:${assignmentId}:${digest}`
}

export function activeAssignmentId(ticket: Ticket): string | undefined {
  const running = ticket.assignments.find(item => item.state === 'running')
  if (running) return running.id
  return ticket.assignments.at(-1)?.id
}

function unknownApprovalForTicket(approvals: readonly ApprovalRequest[] | undefined): ApprovalRequest | undefined {
  return approvals?.find(isUnknownOutcomeApproval)
}

/** True when restart recovery must not auto-replay uncertain external effects. */
export function blocksRestartRecovery(ticket: Ticket, store: Store): boolean {
  if (hasOpenUnknownEffects(ticket.id, store)) return true
  if (pendingApproval(ticket)) return true
  return false
}

export function hasOpenUnknownEffects(ticketId: string, store: Store): boolean {
  const ops = store.listDocs<ExternalOperationRecord>(EXTERNAL_OP_KIND)
    .filter(op => op.ticketId === ticketId && op.phase === 'unknown_outcome')
  if (ops.length > 0) return true
  return store.listOutbox('unknown_outcome').some(row => row.ticketId === ticketId)
}

export function putExternalOp(store: Store, record: ExternalOperationRecord): void {
  store.putDoc(EXTERNAL_OP_KIND, record.id, record)
}

export function beginDelegateOperation(input: {
  store: Store
  ticketId: string
  assignmentId: string
  sessionId: string
  agent: string
  task: string
  now: string
}): ExternalOperationRecord {
  const id = input.store.nextId('extop')
  const record: ExternalOperationRecord = {
    schemaVersion: 1,
    id,
    kind: 'delegate_agent',
    ticketId: input.ticketId,
    assignmentId: input.assignmentId,
    sessionId: input.sessionId,
    idempotencyKey: delegateIdempotencyKey(input.ticketId, input.assignmentId, input.agent, input.task),
    phase: 'started',
    startedAt: input.now,
    updatedAt: input.now,
    detail: `agent=${input.agent}`,
  }
  putExternalOp(input.store, record)
  return record
}

export function finishDelegateOperation(
  store: Store,
  id: string,
  phase: 'completed' | 'failed',
  now: string,
  detail?: string,
): void {
  const current = store.getDoc<ExternalOperationRecord>(EXTERNAL_OP_KIND, id)
  if (!current) return
  putExternalOp(store, {
    ...current,
    phase,
    updatedAt: now,
    ...(detail ? { detail } : {}),
  })
}

export function recordOutboxSendStart(store: Store, row: OutboxRow, now: string): void {
  const id = `outbox_${row.id}`
  const record: ExternalOperationRecord = {
    schemaVersion: 1,
    id,
    kind: 'outbox_send',
    ticketId: row.ticketId,
    idempotencyKey: row.idempotencyKey ?? row.id,
    phase: 'started',
    startedAt: now,
    updatedAt: now,
    detail: `outboxId=${row.id} channel=${row.channel}`,
  }
  putExternalOp(store, record)
}

export function finishOutboxSendOperation(
  store: Store,
  row: OutboxRow,
  phase: 'completed' | 'failed',
  now: string,
  detail?: string,
): void {
  const id = `outbox_${row.id}`
  const current = store.getDoc<ExternalOperationRecord>(EXTERNAL_OP_KIND, id)
  if (!current || current.phase !== 'started') return
  putExternalOp(store, {
    ...current,
    phase,
    updatedAt: now,
    ...(detail ? { detail } : {}),
  })
}

/**
 * After a crash: in-flight delegate runs and mid-send outbox rows cannot be
 * replayed blindly. Mark uncertainty and require owner approval first.
 */
export function finalizeUncertainExternalEffects(
  store: Store,
  now: string,
): { unknownOps: number; unknownOutbox: number; approvalsQueued: number } {
  let unknownOps = 0
  for (const op of store.listDocs<ExternalOperationRecord>(EXTERNAL_OP_KIND)) {
    if (op.phase !== 'started') continue
    putExternalOp(store, { ...op, phase: 'unknown_outcome', updatedAt: now })
    unknownOps += 1
  }
  const unknownOutbox = store.markSendingOutboxUnknownOutcome()
  const tickets = new Set<string>()
  for (const op of store.listDocs<ExternalOperationRecord>(EXTERNAL_OP_KIND)) {
    if (op.phase === 'unknown_outcome') tickets.add(op.ticketId)
  }
  for (const row of store.listOutbox('unknown_outcome')) tickets.add(row.ticketId)
  let approvalsQueued = 0
  for (const ticketId of tickets) {
    if (queueUnknownOutcomeApproval(store, ticketId, now)) approvalsQueued += 1
  }
  return { unknownOps, unknownOutbox, approvalsQueued }
}

function queueUnknownOutcomeApproval(store: Store, ticketId: string, now: string): boolean {
  const ticket = store.getDoc<Ticket>('ticket', ticketId)
  if (!ticket || ticket.ended) return false
  const collab = ensureCollaboration(ticket)
  if (unknownApprovalForTicket(collab.approvals)) return false
  const effectIds = unknownEffectIds(ticketId, store)
  if (effectIds.length === 0) return false
  const action = `${UNKNOWN_OUTCOME_PREFIX} ${describeUnknownEffects(ticketId, store)}`
  const approval: ApprovalRequest = {
    id: store.nextId('appr'),
    at: now,
    action,
    actionId: approvalActionId(action),
    reason: 'Process stopped before an external effect finished; approve only after verifying remote state.',
    requestedBy: 'recovery',
    recovery: { source: 'crash-boundary', effectIds },
    status: 'pending',
  }
  collab.approvals!.push(approval)
  store.putDoc('ticket', ticket.id, ticket)
  store.addEvent('approval.requested', {
    ticketId: ticket.id,
    approvalId: approval.id,
    action: approval.action,
    source: 'unknown-outcome',
  })
  return true
}

function describeUnknownEffects(ticketId: string, store: Store): string | undefined {
  const pieces: string[] = []
  const ops = store.listDocs<ExternalOperationRecord>(EXTERNAL_OP_KIND)
    .filter(op => op.ticketId === ticketId && op.phase === 'unknown_outcome')
  for (const op of ops) {
    pieces.push(`${op.kind} key=${op.idempotencyKey}`)
  }
  const outbox = store.listOutbox('unknown_outcome').filter(row => row.ticketId === ticketId)
  for (const row of outbox) {
    pieces.push(`outbox_send key=${row.idempotencyKey ?? row.id}`)
  }
  if (pieces.length === 0) return undefined
  return pieces.join('; ')
}

/** Owner approved continuation: release rows for idempotent retry / recovery. */
export type UnknownOutcomeResolution = 'retry' | 'acknowledge'

/**
 * Resolve exact effect ids selected by a recovery approval or an operator.
 * This is intentionally usable for an ended Ticket, where a normal approval
 * cannot be decided because no Worker may resume.
 */
export function resolveUnknownOutcomeEffects(
  store: Store,
  ticketId: string,
  effectIds: readonly string[],
  resolution: UnknownOutcomeResolution,
  now: string,
): number {
  const selected = [...new Set(effectIds)]
  if (selected.length !== effectIds.length || selected.length === 0) return 0
  const available = new Set(unknownEffectIds(ticketId, store))
  if (selected.some(id => !available.has(id))) return 0
  let released = 0
  for (const op of store.listDocs<ExternalOperationRecord>(EXTERNAL_OP_KIND)) {
    if (op.ticketId !== ticketId || op.phase !== 'unknown_outcome' || !selected.includes(op.id)) continue
    putExternalOp(store, {
      ...op,
      phase: resolution === 'retry' ? 'operator_released' : 'operator_acknowledged',
      updatedAt: now,
    })
    released += 1
  }
  const outboxIds = selected
    .filter(id => id.startsWith('outbox_'))
    .map(id => id.slice('outbox_'.length))
  released += resolution === 'retry'
    ? store.requeueUnknownOutcomeOutboxIds(ticketId, outboxIds)
    : store.acknowledgeUnknownOutcomeOutboxIds(ticketId, outboxIds)
  return released
}

/** Owner approved the exact recovery approval effect set for idempotent retry. */
export function releaseUnknownOutcomeEffects(
  store: Store,
  ticketId: string,
  effectIds: readonly string[],
  now: string,
): number {
  return resolveUnknownOutcomeEffects(store, ticketId, effectIds, 'retry', now)
}

export function unknownEffectIds(ticketId: string, store: Store): string[] {
  const ids = new Set(
    store.listDocs<ExternalOperationRecord>(EXTERNAL_OP_KIND)
      .filter(op => op.ticketId === ticketId && op.phase === 'unknown_outcome')
      .map(op => op.id),
  )
  for (const row of store.listOutbox('unknown_outcome')) {
    if (row.ticketId === ticketId) ids.add(`outbox_${row.id}`)
  }
  return [...ids].sort()
}

/** Only uncertain Outbox rows have a durable redrain path after a Ticket ends. */
export function retryableUnknownEffectIds(ticketId: string, store: Store): string[] {
  return store.listOutbox('unknown_outcome')
    .filter(row => row.ticketId === ticketId)
    .map(row => `outbox_${row.id}`)
    .sort()
}

export function isUnknownOutcomeApproval(approval: ApprovalRequest): boolean {
  return approval.status === 'pending'
    && approval.requestedBy === 'recovery'
    && approval.recovery?.source === 'crash-boundary'
    && approval.recovery.effectIds.length > 0
}

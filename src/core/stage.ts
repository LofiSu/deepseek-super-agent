import type { Ticket } from '../shared/types.ts'

/**
 * Canonical Panel/Execution states, derived from Ticket facts rather than from
 * the model's last sentence.
 */
export type ExecutionState =
  | 'open'
  | 'pending'
  | 'working'
  | 'waiting-for-trigger'
  | 'awaiting-answer'
  | 'awaiting-review'
  | 'blocked'
  | 'ended'

export function executionState(ticket: Ticket): ExecutionState {
  if (ticket.ended) return 'ended'
  if (ticket.collab?.paused) return 'blocked'
  const assignment = ticket.assignments.at(-1)
  if (!assignment) return 'open'
  if (assignment.report?.kind === 'failed' || assignment.report?.kind === 'blocked') return 'blocked'
  if (assignment.report?.kind === 'waiting') return 'waiting-for-trigger'
  if (assignment.report?.kind === 'ready') return 'awaiting-review'
  if (assignment.report?.question) return 'awaiting-answer'
  if (assignment.state === 'pending') return 'pending'
  if (assignment.state === 'running') return 'working'
  return 'open'
}

/**
 * Legacy compact label used by `ds-agent tasks` and the Watchdog. Keep the
 * `group/state` shape while sourcing it from `executionState`.
 */
export function ticketStage(ticket: Ticket): string {
  if (ticket.ended) return `ended/${ticket.ended.outcome}`
  if (ticket.collab?.paused) return 'person/paused'
  const state = executionState(ticket)
  if (state === 'blocked') return 'person/blocked'
  if (state === 'awaiting-review') return 'person/review'
  if (state === 'awaiting-answer') return 'person/answer'
  if (state === 'waiting-for-trigger') return 'idle'
  if (state === 'pending') return 'working/queued'
  if (state === 'working') return 'working'
  return 'working/queued'
}

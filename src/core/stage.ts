import type { Ticket } from '../shared/types.ts'

/** First matching row wins. Watchdog and `ds-agent tasks` read this. */
export function ticketStage(ticket: Ticket): string {
  if (ticket.ended) return `ended/${ticket.ended.outcome}`
  if (ticket.collab?.paused) return 'person/paused'
  const assignment = ticket.assignments.at(-1)
  if (!assignment || assignment.state === 'pending') return 'working/queued'
  if (assignment.report?.kind === 'failed' || assignment.report?.kind === 'blocked') return 'person/blocked'
  if (assignment.report?.kind === 'ready') return 'person/review'
  if (assignment.report?.kind === 'waiting') return 'idle'
  if (assignment.state === 'running') return 'working'
  return 'working'
}

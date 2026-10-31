import { AgentError } from '../shared/errors.js'
import type { Report } from '../shared/types.js'
import type { EngineHost } from './ports.js'
import { queueReply } from './replies.js'
import { loadTicket, newAssignment, persistTicket } from './tickets.js'

export function assignmentStarted(host: EngineHost, ticketId: string, assignmentId: string): void {
  const ticket = loadTicket(host, ticketId)
  const assignment = ticket.assignments.find(item => item.id === assignmentId)
  if (!assignment) throw new AgentError('assignment_missing', assignmentId)
  if (assignment.state !== 'pending') throw new AgentError('assignment_state', assignment.state)
  const now = host.now()
  assignment.state = 'running'
  assignment.startedAt = now
  ticket.updatedAt = now
  persistTicket(host, ticket)
  host.emit({ type: 'assignment.started', at: now, data: { ticketId, assignmentId } })
  const inputIds = [...(ticket.undelivered ?? [])]
  if (inputIds.length > 0 && host.executor.deliver) {
    const started = snapshot(ticket)
    const running = snapshot(assignment)
    host.effects.push(() => host.executor.deliver!(started, running, inputIds))
  }
}

export function inputsDelivered(host: EngineHost, ticketId: string, assignmentId: string, inputIds: readonly string[]): void {
  const ticket = loadTicket(host, ticketId)
  const assignment = ticket.assignments.find(item => item.id === assignmentId)
  if (!assignment) throw new AgentError('assignment_missing', assignmentId)
  if (assignment.state !== 'running') throw new AgentError('assignment_state', assignment.state)
  const now = host.now()
  const wanted = new Set(inputIds)
  for (const input of ticket.inputs ?? []) {
    if (wanted.has(input.id)) input.deliveredAt = now
  }
  ticket.undelivered = (ticket.undelivered ?? []).filter(id => !wanted.has(id))
  ticket.updatedAt = now
  persistTicket(host, ticket)
}

export function reportAssignment(host: EngineHost, ticketId: string, assignmentId: string, report: Report): void {
  const ticket = loadTicket(host, ticketId)
  const assignment = ticket.assignments.find(item => item.id === assignmentId)
  if (!assignment) throw new AgentError('assignment_missing', assignmentId)
  if (assignment.state !== 'running') throw new AgentError('assignment_state', assignment.state)
  assignment.report = report
  ticket.updatedAt = host.now()
  if (report.state === 'ready' || report.state === 'dropped') {
    assignment.state = 'ended'
    assignment.endedAt = report.at
    assignment.endedReason = report.state
    ticket.status = 'ended'
    ticket.ended = {
      at: report.at,
      by: 'executor',
      outcome: report.state === 'ready' ? 'completed' : 'dropped',
      reason: report.summary,
    }
    queueReply(host, ticket, 'result', report.summary)
  } else if (report.state === 'blocked' || report.state === 'failed') {
    queueReply(host, ticket, 'attention', report.summary)
  }
  persistTicket(host, ticket)
}

export function assignmentInterrupted(host: EngineHost, ticketId: string, assignmentId: string): void {
  const ticket = loadTicket(host, ticketId)
  const assignment = ticket.assignments.find(item => item.id === assignmentId)
  if (!assignment) throw new AgentError('assignment_missing', assignmentId)
  if (assignment.state !== 'running') throw new AgentError('assignment_state', assignment.state)
  const now = host.now()
  const stopped = snapshot(assignment)
  assignment.state = 'ended'
  assignment.endedAt = now
  assignment.endedReason = 'interrupted'
  const reason = 'interrupted'
  host.effects.push(() => host.executor.stop?.(snapshot(ticket), stopped, reason))
  const next = newAssignment(host, ticket.id)
  ticket.assignments = [...ticket.assignments, next]
  ticket.updatedAt = now
  persistTicket(host, ticket)
  const started = snapshot(ticket)
  const startedAssignment = snapshot(next)
  host.effects.push(() => host.executor.start(started, startedAssignment))
}

function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

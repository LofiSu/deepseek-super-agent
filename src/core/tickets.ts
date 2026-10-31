import { AgentError } from '../shared/errors.js'
import { threadKey, type Assignment, type ChannelRef, type Thread, type Ticket, type Trigger } from '../shared/types.js'
import type { Assessment, EngineHost } from './ports.js'
import { queueReply } from './replies.js'
import { subscribe } from './subscribe.js'

export function loadTicket(host: EngineHost, ticketId: string): Ticket {
  const ticket = host.repos.tickets.get(ticketId)
  if (!ticket) throw new AgentError('ticket_missing', ticketId)
  return ticket
}

export function persistTicket(host: EngineHost, ticket: Ticket): void {
  host.repos.tickets.save(ticket)
  for (const assignment of ticket.assignments) host.repos.assignments.save(assignment)
  for (const channel of ticket.channels) host.repos.channels.save({ ref: channel, ticketId: ticket.id })
}

export function newAssignment(host: EngineHost, ticketId: string): Assignment {
  return { id: host.id('assignment'), ticketId, state: 'pending', createdAt: host.now() }
}

export function deliverTrigger(host: EngineHost, ticket: Ticket, trigger: Trigger): void {
  const input = {
    id: host.id('input'),
    kind: 'trigger' as const,
    at: trigger.at,
    triggerId: trigger.id,
    ...(trigger.human ? { human: true } : {}),
  }
  ticket.inputs = [...(ticket.inputs ?? []), input]
  ticket.undelivered = [...(ticket.undelivered ?? []), input.id]
  ticket.updatedAt = host.now()
}

/** Accept creates the Mandate, Ticket, first Assignment, and Subscriptions. */
export function acceptTicket(host: EngineHost, thread: Thread, triggers: Trigger[], assessment: Assessment, strength: Ticket['mandate']['strength'], policyVersion: string, decisionId: string): Ticket {
  const primary = triggers[0]
  if (!primary) throw new AgentError('eval_empty', 'accept needs a trigger')
  const now = host.now()
  const ticketId = host.id('ticket')
  const assignment = newAssignment(host, ticketId)
  const mandate = {
    strength,
    policyVersion,
    actor: primary.actor,
    scope: assessment.scope ?? assessment.title ?? primary.text,
  }
  const origin = triggers.map(trigger => ({
    id: host.id('input'),
    kind: 'trigger' as const,
    at: trigger.at,
    triggerId: trigger.id,
    ...(trigger.human ? { human: true } : {}),
  }))
  const ticket: Ticket = {
    id: ticketId,
    title: assessment.title ?? primary.text.slice(0, 80),
    decisionId,
    mandate,
    channels: channelsOf(triggers),
    status: 'open',
    assignments: [assignment],
    createdAt: now,
    updatedAt: now,
    inputs: origin,
    undelivered: origin.map(input => input.id),
  }
  persistTicket(host, ticket)
  const keys = new Set<string>([thread.key])
  for (const trigger of triggers) {
    for (const ref of trigger.threads) keys.add(threadKey(ref))
  }
  for (const key of keys) {
    const current = key === thread.key ? thread : host.repos.threads.get(key)
    if (current) subscribe(host, current, ticket.id)
  }
  queueReply(host, ticket, 'acknowledgement', ticket.title)
  const started = snapshot(ticket)
  const startedAssignment = snapshot(assignment)
  host.effects.push(() => host.executor.start(started, startedAssignment))
  return ticket
}

export function resumeTicket(host: EngineHost, ticket: Ticket, trigger: Trigger): void {
  if (ticket.ended?.by === 'human') return
  const now = host.now()
  ticket.status = 'open'
  delete ticket.ended
  const input = { id: host.id('input'), kind: 'resumed' as const, at: trigger.at, triggerId: trigger.id, human: true as const }
  ticket.inputs = [...(ticket.inputs ?? []), input]
  ticket.undelivered = [...(ticket.undelivered ?? []), input.id]
  ticket.updatedAt = now
  const active = ticket.assignments.find(item => item.state === 'pending' || item.state === 'running')
  if (!active) {
    const assignment = newAssignment(host, ticket.id)
    ticket.assignments = [...ticket.assignments, assignment]
    const started = snapshot(ticket)
    const startedAssignment = snapshot(assignment)
    host.effects.push(() => host.executor.start(started, startedAssignment))
  }
}

export function stopTicket(host: EngineHost, ticketId: string, reason = 'stopped'): Ticket {
  const ticket = loadTicket(host, ticketId)
  const now = host.now()
  ticket.status = 'ended'
  ticket.ended = { at: now, by: 'human', outcome: 'stopped', reason }
  ticket.updatedAt = now
  for (const assignment of ticket.assignments) {
    if (assignment.state === 'ended') continue
    const running = assignment.state === 'running'
    const stopped = snapshot(assignment)
    assignment.state = 'ended'
    assignment.endedAt = now
    assignment.endedReason = reason
    if (running) {
      const ended = snapshot(ticket)
      host.effects.push(() => host.executor.stop?.(ended, stopped, reason))
    }
  }
  persistTicket(host, ticket)
  return ticket
}

export function retryTicket(host: EngineHost, ticketId: string): Ticket {
  const ticket = loadTicket(host, ticketId)
  if (ticket.status !== 'open') throw new AgentError('ticket_ended', ticketId)
  const latest = ticket.assignments.at(-1)
  if (!latest) throw new AgentError('assignment_missing', ticketId)
  const blocked = latest.report?.state === 'blocked' || latest.report?.state === 'failed' || latest.state === 'ended'
  if (!blocked) throw new AgentError('retry', 'assignment is still running')
  const now = host.now()
  if (latest.state !== 'ended') {
    latest.state = 'ended'
    latest.endedAt = now
    latest.endedReason = 'retry'
  }
  const assignment = newAssignment(host, ticket.id)
  ticket.assignments = [...ticket.assignments, assignment]
  ticket.updatedAt = now
  persistTicket(host, ticket)
  const started = snapshot(ticket)
  const startedAssignment = snapshot(assignment)
  host.effects.push(() => host.executor.start(started, startedAssignment))
  return ticket
}

function channelsOf(triggers: Trigger[]): ChannelRef[] {
  const seen = new Set<string>()
  const channels: ChannelRef[] = []
  for (const trigger of triggers) {
    if (!trigger.channel) continue
    const key = JSON.stringify(trigger.channel)
    if (seen.has(key)) continue
    seen.add(key)
    channels.push(trigger.channel)
  }
  return channels
}

function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

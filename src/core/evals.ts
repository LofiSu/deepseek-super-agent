import { AgentError } from '../shared/errors.js'
import type { Decision, Eval, Thread, Ticket, Trigger } from '../shared/types.js'
import type { Assessment, EngineHost } from './ports.js'
import { acceptTicket, stopTicket } from './tickets.js'

export function evaluateDue(host: EngineHost): void {
  for (const listed of host.repos.threads.list()) {
    expireIfDue(host, listed.key)
    const thread = host.repos.threads.get(listed.key)
    if (!thread || thread.evaluating || thread.pending.length === 0) continue
    startEval(host, thread)
  }
}

export function decide(host: EngineHost, evalId: string, assessment: Assessment): Decision {
  const thread = host.repos.threads.list().find(item => item.evaluating?.id === evalId)
  if (!thread?.evaluating) throw new AgentError('eval_missing', evalId)
  const triggers = loadTriggers(host, thread.evaluating.triggerIds)
  return finishEval(host, thread, thread.evaluating, triggers, assessment)
}

function expireIfDue(host: EngineHost, key: string): void {
  const thread = host.repos.threads.get(key)
  const evaluation = thread?.evaluating
  if (!thread || !evaluation?.deadline || evaluation.deadline > host.now()) return
  const triggers = loadTriggers(host, evaluation.triggerIds)
  finishEval(host, thread, evaluation, triggers, { kind: 'unavailable', reason: 'deadline' })
}

function startEval(host: EngineHost, thread: Thread): void {
  const triggerIds = [...thread.pending]
  thread.pending = []
  const triggers = loadTriggers(host, triggerIds)
  const tickets = ticketsOn(host, thread)
  const gated = triggers.map(trigger => ({ trigger, gate: host.gate.admit(trigger, thread, tickets) }))
  const primary = gated.find(item => item.gate.admissible && item.gate.strength === 'explicit')
    ?? gated.find(item => item.gate.admissible)
  const admitted = primary?.gate.admissible ? primary.gate : undefined
  const now = host.now()
  const evaluation: Eval = {
    id: host.id('eval'),
    threadKey: thread.key,
    triggerIds,
    strength: admitted?.strength ?? 'inferred',
    policyVersion: admitted?.policyVersion ?? host.policyVersion,
    startedAt: now,
    deadline: plus(now, host.evalTimeoutMs),
  }
  host.repos.evals.save(evaluation)
  host.emit({
    type: 'eval.started',
    at: now,
    data: { evalId: evaluation.id, threadKey: thread.key, triggerIds, strength: evaluation.strength },
  })
  if (!admitted) {
    finishEval(host, thread, evaluation, triggers, { kind: 'ignore', reason: 'gate' })
    return
  }
  thread.evaluating = evaluation
  const assessment = host.assessor.assess({ evaluation, triggers, thread, tickets })
  if (!assessment) {
    host.repos.threads.save(thread)
    return
  }
  finishEval(host, thread, evaluation, triggers, assessment)
}

function finishEval(host: EngineHost, thread: Thread, evaluation: Eval, triggers: Trigger[], assessment: Assessment): Decision {
  const now = host.now()
  const decision: Decision = {
    id: host.id('decision'),
    evalId: evaluation.id,
    threadKey: thread.key,
    triggerIds: evaluation.triggerIds,
    policyVersion: evaluation.policyVersion,
    at: now,
    kind: assessment.kind,
    strength: evaluation.strength,
    ...(assessment.reason ? { reason: assessment.reason } : {}),
  }
  if (assessment.kind === 'accept') {
    const ticket = acceptTicket(host, thread, triggers, assessment, evaluation.strength, evaluation.policyVersion, decision.id)
    decision.ticketId = ticket.id
    decision.mandate = ticket.mandate
    host.emit({ type: 'ticket.created', at: now, data: { ticketId: ticket.id, decisionId: decision.id } })
  } else if (assessment.kind === 'stop') {
    if (!assessment.ticketId) throw new AgentError('ticket_missing', 'stop needs a ticket')
    stopTicket(host, assessment.ticketId, assessment.reason ?? 'stopped')
    decision.ticketId = assessment.ticketId
  }
  thread.evaluating = undefined
  host.repos.decisions.save(decision)
  host.repos.threads.save(thread)
  host.emit({
    type: 'decision.recorded',
    at: now,
    data: { decisionId: decision.id, kind: decision.kind, threadKey: thread.key },
  })
  return decision
}

function ticketsOn(host: EngineHost, thread: Thread): Ticket[] {
  return host.repos.subscriptions.byThread(thread.key).flatMap(subscription => {
    const ticket = host.repos.tickets.get(subscription.ticketId)
    return ticket ? [ticket] : []
  })
}

function loadTriggers(host: EngineHost, ids: string[]): Trigger[] {
  return ids.map(id => {
    const trigger = host.repos.triggers.get(id)
    if (!trigger) throw new AgentError('trigger_missing', id)
    return trigger
  })
}

function plus(iso: string, ms: number): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) throw new AgentError('clock', iso)
  return new Date(time + ms).toISOString()
}

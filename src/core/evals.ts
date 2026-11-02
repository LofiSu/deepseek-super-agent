import { nextBatch } from '../ingress/batch.ts'
import { UserError } from '../shared/errors.ts'
import type { AssessmentOutcome } from '../shared/ports.ts'
import { threadKey, type Decision, type DecisionKind, type Strength, type Thread, type Ticket, type Trigger } from '../shared/types.ts'
import type { Host } from './host.ts'
import { arbitrateSubscribers } from './intake.ts'
import { DEFAULT_POLICY, gateTriggers, type Policy } from './policy.ts'
import type { Tickets } from './tickets.ts'

export class Evals {
  constructor(
    private readonly host: Host,
    private readonly tickets: Tickets,
    private readonly policy: Policy = DEFAULT_POLICY,
  ) {}

  /**
   * Deterministic Eval. It accepts only what Policy can decide without an LLM.
   * A `defer` keeps the Triggers queued and asks the Main Agent to assess them.
   */
  evaluateDue(): Decision[] {
    const decisions: Decision[] = []
    const due = this.host.repo.listDocs<Thread>('thread').filter(thread => thread.pending.length > 0)
    for (const thread of due) {
      const ids = nextBatch(thread.pending)
      const triggers = ids
        .map(id => this.host.repo.getDoc<Trigger>('trigger', id))
        .filter((trigger): trigger is Trigger => trigger != null)
      if (!triggers.length) {
        thread.pending = thread.pending.filter(id => !ids.includes(id))
        thread.deferred = false
        this.host.repo.putDoc('thread', thread.key, thread)
        continue
      }
      const primary = triggers.find(trigger => trigger.addressed) ?? triggers[0]!
      const strength = strengthOf(primary)
      const live = arbitrateSubscribers(
        this.host.repo.listDocs<Ticket>('ticket').filter(ticket =>
          thread.subscriptions.includes(ticket.id) && ticket.ended == null),
      )
      const outcome = gateTriggers(triggers, live, this.policy)
      if (outcome.kind === 'defer') {
        this.host.log(`[engine] Evals.defer thread=${thread.key} reason=${outcome.reason}`)
        thread.deferred = true
        this.host.repo.addEvent('eval.deferred', { threadKey: thread.key, triggerIds: ids, reason: outcome.reason })
        this.host.repo.putDoc('thread', thread.key, thread)
        this.host.onAssessmentNeeded?.(thread.key)
        continue
      }
      thread.deferred = false
      thread.pending = thread.pending.filter(id => !ids.includes(id))
      const evalId = this.host.repo.nextId('eval')
      this.host.log(`[engine] Evals.batch thread=${thread.key} size=${ids.length} triggerIds=${ids.join(',')}`)
      this.host.repo.addEvent('eval.started', { evalId, threadKey: thread.key, triggerIds: ids, strength })
      if (outcome.kind === 'accept') {
        const decision = this.tickets.create({
          thread,
          triggers,
          primary,
          strength: outcome.strength ?? strength,
          evalId,
          reason: outcome.reason,
          policyVersion: this.policy.version,
          rules: outcome.rules,
        })
        this.host.repo.putDoc('thread', thread.key, thread)
        decisions.push(decision)
        continue
      }
      if (outcome.kind === 'stop' && outcome.ticketId) {
        this.tickets.stop(outcome.ticketId, outcome.reason)
      }
      decisions.push(this.record({
        thread,
        triggers,
        strength,
        evalId,
        kind: outcome.kind,
        reason: outcome.reason,
        ticketId: outcome.ticketId,
      }))
      this.host.repo.putDoc('thread', thread.key, thread)
    }
    return decisions
  }

  /** Commit the assessed snapshot only if every trigger is still queued together. */
  commitAssessed(key: string, ids: string[], outcome: AssessmentOutcome): Decision | undefined {
    const thread = this.host.repo.getDoc<Thread>('thread', key)
    if (!thread || ids.length === 0 || ids.some(id => !thread.pending.includes(id))) return undefined
    const triggers = ids.map(id => this.host.repo.getDoc<Trigger>('trigger', id))
    if (triggers.some(trigger => !trigger)) return undefined
    const batch = triggers as Trigger[]
    thread.pending = thread.pending.filter(id => !ids.includes(id))
    thread.deferred = false
    const primary = batch.find(trigger => trigger.addressed) ?? batch[0]!
    const strength = strengthOf(primary)
    const evalId = this.host.repo.nextId('eval')
    this.host.log(`[engine] Evals.batch thread=${key} size=${ids.length} triggerIds=${ids.join(',')}`)
    this.host.repo.addEvent('eval.started', { evalId, threadKey: key, triggerIds: ids, strength })
    if (outcome.kind === 'accept') {
      const decision = this.tickets.create({
        thread,
        triggers: batch,
        primary,
        strength: outcome.strength ?? strength,
        evalId,
        reason: outcome.reason,
        title: outcome.title,
        scope: outcome.scope,
        policyVersion: outcome.policyVersion ?? this.policy.version,
        rules: outcome.rules,
        speculative: outcome.speculative,
      })
      this.host.repo.putDoc('thread', key, thread)
      return decision
    }
    if (outcome.kind === 'stop') this.tickets.stop(outcome.ticketId, outcome.reason)
    const decision = this.record({ thread, triggers: batch, strength, evalId, kind: outcome.kind, reason: outcome.reason,
      ticketId: outcome.kind === 'stop' ? outcome.ticketId : undefined })
    this.host.repo.putDoc('thread', key, thread)
    return decision
  }

  private record(input: {
    thread: Thread
    triggers: Trigger[]
    strength: Strength
    evalId: string
    kind: DecisionKind
    reason: string
    ticketId?: string
  }): Decision {
    const now = this.host.now()
    const decision: Decision = {
      id: this.host.repo.nextId('dec'),
      evalId: input.evalId,
      threadKey: input.thread.key,
      triggerIds: input.triggers.map(trigger => trigger.id),
      kind: input.kind,
      ticketId: input.ticketId,
      at: now,
      reason: input.reason,
      strength: input.strength,
    }
    this.host.repo.putDoc('decision', decision.id, decision)
    this.host.repo.addEvent('decision.recorded', { decisionId: decision.id, kind: input.kind })
    const ticket = input.ticketId ? ` ticketId=${input.ticketId}` : ''
    this.host.log(`[engine] Evals.${input.kind} thread=${input.thread.key}${ticket} reason=${input.reason}`)
    return decision
  }

  /** Router-only assessment. Accept opens a ticket; every other kind stays silent. */
  decide(triggerId: string, outcome: AssessmentOutcome): Decision {
    const trigger = this.host.repo.getDoc<Trigger>('trigger', triggerId)
    if (!trigger) throw new UserError(`unknown trigger ${triggerId}`)
    if (!trigger.threads.length) throw new UserError('A trigger must belong to at least one thread')
    const key = threadKey(trigger.threads[0]!)
    const thread = this.host.repo.getDoc<Thread>('thread', key)
    if (!thread) throw new UserError(`unknown thread ${key}`)
    thread.pending = thread.pending.filter(id => id !== triggerId)
    const strength = strengthOf(trigger)
    const evalId = this.host.repo.nextId('eval')
    this.host.log(`[engine] Evals.decide triggerId=${triggerId} kind=${outcome.kind}`)
    this.host.repo.addEvent('eval.started', { evalId, threadKey: key, triggerIds: [triggerId], strength })
    if (outcome.kind === 'accept') {
      return this.tickets.create({
        thread,
        triggers: [trigger],
        primary: trigger,
        strength: outcome.strength ?? strength,
        evalId,
        reason: outcome.reason,
        title: outcome.title,
        scope: outcome.scope,
        policyVersion: outcome.policyVersion ?? this.policy.version,
        rules: outcome.rules,
        speculative: outcome.speculative,
      })
    }
    this.host.repo.putDoc('thread', thread.key, thread)
    if (outcome.kind === 'stop') this.stopTicket(outcome.ticketId)
    const now = this.host.now()
    const decision: Decision = {
      id: this.host.repo.nextId('dec'),
      evalId,
      threadKey: thread.key,
      triggerIds: [triggerId],
      kind: outcome.kind,
      ticketId: outcome.kind === 'stop' ? outcome.ticketId : undefined,
      at: now,
      reason: outcome.reason,
      strength,
    }
    this.host.repo.putDoc('decision', decision.id, decision)
    this.host.repo.addEvent('decision.recorded', { decisionId: decision.id, kind: outcome.kind })
    return decision
  }

  private stopTicket(ticketId: string, by: 'human' | 'router' = 'router'): void {
    const ticket = this.host.repo.getDoc<Ticket>('ticket', ticketId)
    if (!ticket) throw new UserError(`unknown ticket ${ticketId}`)
    const now = this.host.now()
    const wasLive = !ticket.ended
    if (!ticket.ended) ticket.ended = { at: now, outcome: 'stopped', by }
    const assignment = ticket.assignments.at(-1)
    if (assignment && assignment.state !== 'ended') {
      assignment.state = 'ended'
      assignment.endedAt = now
      this.host.repo.addEvent('assignment.ended', {
        ticketId: ticket.id,
        assignmentId: assignment.id,
        kind: 'stop',
      })
    }
    this.host.repo.putDoc('ticket', ticket.id, ticket)
    this.host.log(`[engine] Evals.stop ticketId=${ticket.id}`)
    if (!wasLive) return
    try {
      this.host.onTicketEnded?.(ticket)
    } catch (error) {
      this.host.log(`[hook] hook=ended ticketId=${ticket.id} error=${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function strengthOf(trigger: Trigger): Strength {
  const value = trigger.meta.strength
  if (value === 'explicit' || value === 'inferred' || value === 'maybe') return value
  if (trigger.addressed) return 'explicit'
  return 'inferred'
}
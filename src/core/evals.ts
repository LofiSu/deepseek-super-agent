import { nextBatch } from '../ingress/batch.ts'
import { UserError } from '../shared/errors.ts'
import type { AssessmentOutcome } from '../shared/ports.ts'
import { threadKey, type Decision, type Strength, type Thread, type Ticket, type Trigger } from '../shared/types.ts'
import type { Host } from './host.ts'
import type { Tickets } from './tickets.ts'

export class Evals {
  constructor(private readonly host: Host, private readonly tickets: Tickets) {}

  evaluateDue(): Decision[] {
    const decisions: Decision[] = []
    const due = this.host.repo.listDocs<Thread>('thread').filter(thread => thread.pending.length > 0)
    for (const thread of due) {
      const ids = nextBatch(thread.pending)
      thread.pending = []
      const triggers = ids
        .map(id => this.host.repo.getDoc<Trigger>('trigger', id))
        .filter((trigger): trigger is Trigger => trigger != null)
      if (!triggers.length) {
        this.host.repo.putDoc('thread', thread.key, thread)
        continue
      }
      const primary = triggers.find(trigger => trigger.addressed) ?? triggers[0]!
      const strength = strengthOf(primary)
      const evalId = this.host.repo.nextId('eval')
      this.host.log(`[engine] Evals.batch thread=${thread.key} size=${ids.length} triggerIds=${ids.join(',')}`)
      this.host.repo.addEvent('eval.started', { evalId, threadKey: thread.key, triggerIds: ids, strength })
      const decision = this.tickets.create({ thread, triggers, primary, strength, evalId })
      this.host.repo.putDoc('thread', thread.key, thread)
      decisions.push(decision)
    }
    return decisions
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
        strength,
        evalId,
        reason: outcome.reason,
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

  private stopTicket(ticketId: string): void {
    const ticket = this.host.repo.getDoc<Ticket>('ticket', ticketId)
    if (!ticket) throw new UserError(`unknown ticket ${ticketId}`)
    const now = this.host.now()
    if (!ticket.ended) ticket.ended = { at: now, outcome: 'stopped', by: 'human' }
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
  }
}

function strengthOf(trigger: Trigger): Strength {
  const value = trigger.meta.strength
  if (value === 'explicit' || value === 'inferred' || value === 'maybe') return value
  if (trigger.addressed) return 'explicit'
  return 'inferred'
}

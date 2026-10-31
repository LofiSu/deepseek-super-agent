import { nextBatch } from '../ingress/batch.ts'
import type { Decision, DecisionKind, Strength, Thread, Ticket, Trigger } from '../shared/types.ts'
import { assessTriggers } from './assessment.ts'
import type { Host } from './host.ts'
import { arbitrateSubscribers } from './intake.ts'
import type { Tickets } from './tickets.ts'

export class Evals {
  constructor(private readonly host: Host, private readonly tickets: Tickets) {}

  /**
   * Sequence point: every pending batch is assessed before any ticket is opened.
   * ignore, stop, and unavailable do not create a ticket and do not start a worker.
   */
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
      const live = arbitrateSubscribers(
        this.host.repo.listDocs<Ticket>('ticket').filter(ticket =>
          thread.subscriptions.includes(ticket.id) && ticket.ended == null),
      )
      const outcome = assessTriggers(triggers, live)
      if (outcome.kind === 'accept') {
        const decision = this.tickets.create({ thread, triggers, primary, strength, evalId })
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
}

function strengthOf(trigger: Trigger): Strength {
  const value = trigger.meta.strength
  if (value === 'explicit' || value === 'inferred' || value === 'maybe') return value
  if (trigger.addressed) return 'explicit'
  return 'inferred'
}

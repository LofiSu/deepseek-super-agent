import { grantTicketSpill } from '../memory/acl.ts'
import { UserError } from '../shared/errors.ts'
import { commandOf } from './assessment.ts'
import {
  threadKey,
  type Assignment,
  type Disposition,
  type ReceiveResult,
  type Thread,
  type ThreadRef,
  type Ticket,
  type Trigger,
  type TriggerTrust,
} from '../shared/types.ts'
import type { Host } from './host.ts'

export class Intake {
  constructor(private readonly host: Host) {}

  /**
   * `trust` is the ingress layer's own record for this trigger. It is the only
   * source of spill grants and strength; fields on `trigger.meta` are ignored
   * because any adapter could set them.
   */
  receive(trigger: Trigger, trust: TriggerTrust = {}): ReceiveResult {
    if (!trigger.threads.length) throw new UserError('A trigger must belong to at least one thread')
    if (this.host.repo.getDoc<Trigger>('trigger', trigger.id)) return 'duplicate'
    const at = this.host.now()
    const gate = this.host.scope.admit(
      trust.filterText ? { ...trigger, text: trust.filterText } : trigger,
    )
    // Persist engine-authored meta only. Caller meta is data, not a decision.
    const owned: Trigger = {
      ...trigger,
      meta: {
        label: trigger.text.replace(/\s+/g, ' ').trim().slice(0, 80),
        ...(trust.strength ? { strength: trust.strength } : {}),
        ...(trust.spillId ? { spillId: trust.spillId } : {}),
      },
    }
    if (!gate.listened) {
      this.host.repo.putDoc('trigger', trigger.id, owned)
      const disposition: Disposition = { filtered: gate.reason, fanout: [], at }
      this.host.repo.putDoc('disposition', trigger.id, disposition)
      this.host.repo.addEvent('trigger.received', { triggerId: trigger.id, result: 'filtered', reason: gate.reason })
      return 'filtered'
    }

    this.host.repo.putDoc('trigger', trigger.id, owned)
    const keys = trigger.threads.map(threadKey)
    let primary: Thread | undefined
    const fanout: string[] = []
    const context: string[] = []
    const seen = new Set<string>()
    const command = commandOf(trigger.text)
    for (const ref of trigger.threads) {
      const thread = this.ensure(ref)
      if (!primary) primary = thread
      if (!thread.lastAt || trigger.at > thread.lastAt) thread.lastAt = trigger.at
      thread.correlated = [...new Set([...thread.correlated, ...keys.filter(key => key !== thread.key)])]
      // Stop / ignore / unavailable stay on the Eval queue instead of bypassing into an Executor.
      if (!command) {
        const live: string[] = []
        for (const ticketId of thread.subscriptions) {
          if (seen.has(ticketId)) continue
          seen.add(ticketId)
          const ticket = this.host.repo.getDoc<Ticket>('ticket', ticketId)
          // Drop stale ids instead of resurrecting an ended ticket on a later follow-up.
          if (!ticket || ticket.ended) continue
          live.push(ticketId)
          const meta = thread.subscriptionMeta?.[ticketId]
          if (!subscriptionEligible(ticket)) continue
          const contextOnly = meta?.contextOnly === true || isContextOnly(thread, ticketId)
            || ticket.contextOnlyThreads?.includes(thread.key) === true
          // A human follow-up on a live, non-context-only subscription is actionable.
          // A bot/CI event and a context-only subscription only add background.
          const actionable = bypassEligible(ticket, trigger, meta) && !contextOnly
          addInput(this.host, ticket, trigger, actionable ? 'trigger' : 'context', at)
          if (actionable) fanout.push(ticket.id)
          else context.push(ticket.id)
        }
        thread.subscriptions = live
      }
      this.host.repo.putDoc('thread', thread.key, thread)
    }

    const primaryKey = primary?.key ?? threadKey(trigger.threads[0]!)
    for (const ticketId of fanout) {
      this.host.log(`bypass=subscription ticketId=${ticketId} thread=${primaryKey} triggerId=${trigger.id}`)
    }
    if (fanout.length > 0) this.host.metrics.increment('bypass.fanout', fanout.length)
    if (context.length > 0) this.host.metrics.increment('bypass.context', context.length)

    // Human follow-ups that reached an actionable subscriber do not need Eval.
    // Bot/CI events and context-only subscriptions still become new-work candidates.
    const needsEval = command != null || trigger.human === false || fanout.length === 0
    if (needsEval && primary) {
      primary.pending = [...primary.pending, trigger.id]
      this.host.repo.putDoc('thread', primary.key, primary)
      this.host.onQueued?.(primary.key, trigger.id, primary.pending)
    }
    const disposition: Disposition = {
      fanout,
      context,
      ...(trust.shards?.length ? { shards: trust.shards } : {}),
      at,
    }
    this.host.repo.putDoc('disposition', trigger.id, disposition)
    this.host.repo.addEvent('trigger.received', {
      triggerId: trigger.id,
      result: 'stored',
      fanout,
      context,
      ...(trust.shards?.length ? { shards: trust.shards } : {}),
    })
    return 'stored'
  }

  private ensure(ref: ThreadRef): Thread {
    const key = threadKey(ref)
    const existing = this.host.repo.getDoc<Thread>('thread', key)
    if (existing) return existing
    const thread: Thread = {
      key,
      ref,
      createdAt: this.host.now(),
      subscriptions: [],
      correlated: [],
      pending: [],
      meta: {},
    }
    this.host.repo.putDoc('thread', key, thread)
    return thread
  }
}

/**
 * Subscription bypass is a human follow-up on a live ticket whose mandate
 * still has scope and has not ended. A contextOnly subscription never bypasses.
 * A different human actor does not silently inherit another person's mandate.
 */
export function bypassEligible(
  ticket: Ticket,
  trigger: Trigger,
  subscription?: { contextOnly?: boolean },
): boolean {
  if (!trigger.human) return false
  if (ticket.ended) return false
  if (subscription?.contextOnly === true) return false
  const scope = ticket.mandate?.scope
  if (typeof scope !== 'string' || scope.trim().length === 0) return false
  const mandateActor = ticket.mandate?.actor?.id
  return !mandateActor || !trigger.actor.id || mandateActor === trigger.actor.id
}

/** A live Ticket with a non-empty Mandate can receive Trigger context. */
export function subscriptionEligible(ticket: Ticket): boolean {
  if (ticket.ended) return false
  const scope = ticket.mandate?.scope
  return typeof scope === 'string' && scope.trim().length > 0
}

export function isContextOnly(thread: Thread, ticketId: string): boolean {
  return (thread.contextOnly ?? []).includes(ticketId)
}

function spillOf(trigger: Trigger): string | undefined {
  return typeof trigger.meta.spillId === 'string' ? trigger.meta.spillId : undefined
}

function addInput(
  host: Host,
  ticket: Ticket,
  trigger: Trigger,
  kind: 'trigger' | 'context',
  at: string,
): void {
  ticket.inputs.push({
    id: host.repo.nextId('input'),
    kind,
    triggerId: trigger.id,
    text: trigger.text,
    spillId: spillOf(trigger),
    at,
    human: trigger.human,
  })
  grantTicketSpill(host.repo, spillOf(trigger), ticket.id)
  host.repo.putDoc('ticket', ticket.id, ticket)
}

/** One subscriber wins: an active assignment outranks a finished one, then the latest activity. */
export function arbitrateSubscribers(tickets: Ticket[]): Ticket | undefined {
  if (!tickets.length) return undefined
  return tickets.reduce((best, ticket) => higherSubscriber(best, ticket))
}

function higherSubscriber(left: Ticket, right: Ticket): Ticket {
  const a = subscriberScore(left)
  const b = subscriberScore(right)
  if (a.rank !== b.rank) return a.rank > b.rank ? left : right
  if (a.at !== b.at) return a.at > b.at ? left : right
  if (left.createdAt !== right.createdAt) return left.createdAt > right.createdAt ? left : right
  return left.id > right.id ? left : right
}

function subscriberScore(ticket: Ticket): { rank: number; at: string } {
  let best = { rank: 0, at: ticket.createdAt }
  for (const assignment of ticket.assignments) {
    const rank = assignmentRank(assignment)
    const at = activityAt(ticket, assignment)
    if (rank > best.rank || (rank === best.rank && at > best.at)) best = { rank, at }
  }
  return best
}

function assignmentRank(assignment: Assignment): number {
  if (assignment.state === 'running') return 2
  if (assignment.state === 'pending') return 1
  return 0
}

function activityAt(ticket: Ticket, assignment: Assignment): string {
  let at = ticket.createdAt
  if (assignment.startedAt && assignment.startedAt > at) at = assignment.startedAt
  if (assignment.endedAt && assignment.endedAt > at) at = assignment.endedAt
  return at
}

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
} from '../shared/types.ts'
import type { Host } from './host.ts'

export class Intake {
  constructor(private readonly host: Host) {}

  receive(trigger: Trigger): ReceiveResult {
    if (!trigger.threads.length) throw new UserError('A trigger must belong to at least one thread')
    if (this.host.repo.getDoc<Trigger>('trigger', trigger.id)) return 'duplicate'
    const at = this.host.now()
    const gate = this.host.scope.admit(trigger)
    if (!gate.listened) {
      this.host.repo.putDoc('trigger', trigger.id, trigger)
      const disposition: Disposition = { filtered: gate.reason, fanout: [], at }
      this.host.repo.putDoc('disposition', trigger.id, disposition)
      this.host.repo.addEvent('trigger.received', { triggerId: trigger.id, result: 'filtered', reason: gate.reason })
      return 'filtered'
    }

    this.host.repo.putDoc('trigger', trigger.id, trigger)
    const keys = trigger.threads.map(threadKey)
    let primary: Thread | undefined
    const eligible: Ticket[] = []
    const seen = new Set<string>()
    for (const ref of trigger.threads) {
      const thread = this.ensure(ref)
      if (!primary) primary = thread
      if (!thread.lastAt || trigger.at > thread.lastAt) thread.lastAt = trigger.at
      thread.correlated = [...new Set([...thread.correlated, ...keys.filter(key => key !== thread.key)])]
      // Stop / ignore / unavailable stay on the Eval queue instead of bypassing into the worker.
      if (!commandOf(trigger.text)) {
        for (const ticketId of [...thread.subscriptions]) {
          if (seen.has(ticketId)) continue
          seen.add(ticketId)
          const ticket = this.host.repo.getDoc<Ticket>('ticket', ticketId)
          if (!ticket || !bypassEligible(ticket, trigger)) continue
          eligible.push(ticket)
        }
      }
      this.host.repo.putDoc('thread', thread.key, thread)
    }

    const winner = arbitrateSubscribers(eligible)
    if (winner) {
      winner.inputs.push({
        id: this.host.repo.nextId('input'),
        kind: 'trigger',
        triggerId: trigger.id,
        text: trigger.text,
        spillId: spillOf(trigger),
        at,
        human: trigger.human,
      })
      grantTicketSpill(this.host.repo, spillOf(trigger), winner.id)
      this.host.repo.putDoc('ticket', winner.id, winner)
    }

    const fanout = winner ? [winner.id] : []
    const primaryKey = primary?.key ?? threadKey(trigger.threads[0]!)
    for (const ticketId of fanout) {
      this.host.log(`bypass=subscription ticketId=${ticketId} thread=${primaryKey} triggerId=${trigger.id}`)
    }
    if (fanout.length > 0) this.host.metrics.increment('bypass.fanout', fanout.length)
    if (fanout.length === 0 && primary) {
      primary.pending = [...primary.pending, trigger.id]
      this.host.repo.putDoc('thread', primary.key, primary)
      this.host.onQueued?.(primary.key, trigger.id, primary.pending)
    }
    const disposition: Disposition = { fanout, at }
    this.host.repo.putDoc('disposition', trigger.id, disposition)
    this.host.repo.addEvent('trigger.received', { triggerId: trigger.id, result: 'stored', fanout })
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
 * still has scope and has not ended.
 */
export function bypassEligible(ticket: Ticket, trigger: Trigger): boolean {
  if (!trigger.human) return false
  if (ticket.ended) return false
  const scope = ticket.mandate?.scope
  return typeof scope === 'string' && scope.trim().length > 0
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

function spillOf(trigger: Trigger): string | undefined {
  return typeof trigger.meta.spillId === 'string' && trigger.meta.spillId ? trigger.meta.spillId : undefined
}
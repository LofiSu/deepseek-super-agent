import { UserError } from '../shared/errors.ts'
import {
  threadKey,
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
    const reached = new Set<string>()
    let primary: Thread | undefined
    for (const ref of trigger.threads) {
      const thread = this.ensure(ref)
      if (!primary) primary = thread
      if (!thread.lastAt || trigger.at > thread.lastAt) thread.lastAt = trigger.at
      thread.correlated = [...new Set([...thread.correlated, ...keys.filter(key => key !== thread.key)])]
      for (const ticketId of [...thread.subscriptions]) {
        if (reached.has(ticketId)) continue
        const ticket = this.host.repo.getDoc<Ticket>('ticket', ticketId)
        if (!ticket || !this.deliverable(ticket, trigger)) continue
        ticket.inputs.push({
          id: this.host.repo.nextId('input'),
          kind: 'trigger',
          triggerId: trigger.id,
          text: trigger.text,
          spillId: spillOf(trigger),
          at,
          human: trigger.human,
        })
        this.host.repo.putDoc('ticket', ticket.id, ticket)
        reached.add(ticket.id)
      }
      this.host.repo.putDoc('thread', thread.key, thread)
    }

    const fanout = [...reached]
    const primaryKey = primary?.key ?? threadKey(trigger.threads[0]!)
    for (const ticketId of fanout) {
      this.host.log(`bypass=subscription ticketId=${ticketId} thread=${primaryKey} triggerId=${trigger.id}`)
    }
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

  private deliverable(ticket: Ticket, trigger: Trigger): boolean {
    if (!ticket.ended) return true
    if (ticket.ended.by === 'human') return false
    if (!trigger.human) return false
    delete ticket.ended
    this.host.log(`[engine] Tickets.resume ticketId=${ticket.id} triggerId=${trigger.id}`)
    this.host.repo.addEvent('ticket.resumed', { ticketId: ticket.id, triggerId: trigger.id })
    return true
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

function spillOf(trigger: Trigger): string | undefined {
  return typeof trigger.meta.spillId === 'string' && trigger.meta.spillId ? trigger.meta.spillId : undefined
}

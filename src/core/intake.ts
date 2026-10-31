import { threadKey, type ReceiveResult, type Thread, type ThreadRef, type Trigger } from '../shared/types.js'
import type { EngineHost } from './ports.js'
import { deliverTrigger, persistTicket, resumeTicket } from './tickets.js'

/** Store a Trigger once, record its Threads, and fan out to Subscriptions. */
export function receive(host: EngineHost, trigger: Trigger): ReceiveResult {
  if (host.repos.triggers.get(trigger.id)) return 'duplicate'
  if (trigger.threads.length === 0 || !host.filter(trigger)) return 'filtered'

  host.repos.triggers.save(trigger)
  let bypassEval = false
  const seen = new Set<string>()
  for (const ref of trigger.threads) {
    const key = threadKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    const thread = ensureThread(host, ref, trigger.at)
    thread.lastAt = trigger.at
    if (fanout(host, thread, trigger)) bypassEval = true
    host.repos.threads.save(thread)
  }

  if (!bypassEval) {
    const primary = host.repos.threads.get(threadKey(trigger.threads[0]!))
    if (primary && !primary.pending.includes(trigger.id)) {
      primary.pending = [...primary.pending, trigger.id]
      host.repos.threads.save(primary)
    }
  }

  const threads = trigger.threads.map(ref => threadKey(ref))
  host.emit({
    type: 'trigger.received',
    at: host.now(),
    data: { triggerId: trigger.id, threads, result: 'stored' },
  })
  return 'stored'
}

function ensureThread(host: EngineHost, ref: ThreadRef, at: string): Thread {
  const key = threadKey(ref)
  const existing = host.repos.threads.get(key)
  if (existing) return existing
  const thread: Thread = {
    key,
    ref,
    createdAt: at,
    subscriptions: [],
    pending: [],
    meta: {},
  }
  host.repos.threads.save(thread)
  return thread
}

/** Returns true when a person's message reached a Ticket that owns the Thread. */
function fanout(host: EngineHost, thread: Thread, trigger: Trigger): boolean {
  let bypass = false
  for (const subscription of host.repos.subscriptions.byThread(thread.key)) {
    const ticket = host.repos.tickets.get(subscription.ticketId)
    if (!ticket || ticket.ended?.by === 'human') continue
    const live = ticket.status === 'open'
    if (!live && !trigger.human) continue
    if (subscription.context && !live) continue
    host.logFanout(ticket.id, trigger.id)
    deliverTrigger(host, ticket, trigger)
    if (!live && trigger.human && !subscription.context) resumeTicket(host, ticket, trigger)
    if (trigger.human && !subscription.context) bypass = true
    if (!thread.subscriptions.includes(ticket.id)) thread.subscriptions.push(ticket.id)
    persistTicket(host, ticket)
  }
  return bypass
}

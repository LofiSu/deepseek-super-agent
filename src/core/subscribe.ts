import { UserError } from '../shared/errors.ts'
import { threadKey, type Disposition, type Thread, type Ticket, type Trigger } from '../shared/types.ts'
import type { Host } from './host.ts'

/**
 * Hand a fanned-out trigger back to Eval and drop this ticket's subscription.
 * The next human message on the thread must go through Intake → Eval again
 * (no bypass=subscription for this ticket).
 */
export function handback(host: Host, ticketId: string, triggerId: string, reason: string): boolean {
  const disposition = host.repo.getDoc<Disposition>('disposition', triggerId)
  const trigger = host.repo.getDoc<Trigger>('trigger', triggerId)
  if (!disposition || !trigger) throw new UserError(`unknown trigger ${triggerId}`)
  const at = host.now()
  disposition.handbacks = [...(disposition.handbacks ?? []), { ticketId, reason, at }]
  host.repo.putDoc('disposition', triggerId, disposition)

  const key = threadKey(trigger.threads[0]!)
  const thread = host.repo.getDoc<Thread>('thread', key)
  if (thread) {
    thread.subscriptions = thread.subscriptions.filter(id => id !== ticketId)
    thread.contextOnly = (thread.contextOnly ?? []).filter(id => id !== ticketId)
    if (!thread.pending.includes(triggerId)) thread.pending.push(triggerId)
    host.repo.putDoc('thread', key, thread)
    host.onQueued?.(key, triggerId, thread.pending)
  }

  const ticket = host.repo.getDoc<Ticket>('ticket', ticketId)
  if (ticket) {
    ticket.threadKeys = ticket.threadKeys.filter(item => item !== key)
    ticket.contextOnlyThreads = (ticket.contextOnlyThreads ?? []).filter(item => item !== key)
    host.repo.putDoc('ticket', ticketId, ticket)
  }

  host.log(`[subscribe] handback ticketId=${ticketId} triggerId=${triggerId} reason=${reason} unsubscribed=${key}`)
  host.repo.addEvent('trigger.requeued', { triggerId, ticketId, reason })
  host.repo.addEvent('subscription.removed', { ticketId, threadKey: key, reason: 'handback' })
  return true
}

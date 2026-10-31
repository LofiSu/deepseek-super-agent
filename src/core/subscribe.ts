import { UserError } from '../shared/errors.ts'
import { threadKey, type Disposition, type Thread, type Trigger } from '../shared/types.ts'
import type { Host } from './host.ts'

/** Hand a fanned-out trigger back to Eval. The ticket keeps its subscription. */
export function handback(host: Host, ticketId: string, triggerId: string, reason: string): boolean {
  const disposition = host.repo.getDoc<Disposition>('disposition', triggerId)
  const trigger = host.repo.getDoc<Trigger>('trigger', triggerId)
  if (!disposition || !trigger) throw new UserError(`unknown trigger ${triggerId}`)
  const at = host.now()
  disposition.handbacks = [...(disposition.handbacks ?? []), { ticketId, reason, at }]
  host.repo.putDoc('disposition', triggerId, disposition)
  const key = threadKey(trigger.threads[0]!)
  const thread = host.repo.getDoc<Thread>('thread', key)
  if (thread && !thread.pending.includes(triggerId)) {
    thread.pending.push(triggerId)
    host.repo.putDoc('thread', key, thread)
    host.onQueued?.(key, triggerId, thread.pending)
  }
  host.log(`[subscribe] handback ticketId=${ticketId} triggerId=${triggerId} reason=${reason}`)
  host.repo.addEvent('trigger.requeued', { triggerId, ticketId, reason })
  return true
}

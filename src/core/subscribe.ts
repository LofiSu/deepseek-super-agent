import { AgentError } from '../shared/errors.js'
import type { Thread } from '../shared/types.js'
import type { EngineHost } from './ports.js'

/** Bind a Ticket to a Thread. Context follows do not authorize or resume. */
export function subscribe(host: EngineHost, thread: Thread, ticketId: string, context = false): void {
  if (!thread.subscriptions.includes(ticketId)) thread.subscriptions.push(ticketId)
  host.repos.threads.save(thread)
  host.repos.subscriptions.save({
    threadKey: thread.key,
    ticketId,
    ...(context ? { context: true } : {}),
  })
}

export function unsubscribe(host: EngineHost, threadKey: string, ticketId: string): void {
  const thread = host.repos.threads.get(threadKey)
  if (!thread) throw new AgentError('thread_missing', threadKey)
  thread.subscriptions = thread.subscriptions.filter(id => id !== ticketId)
  host.repos.threads.save(thread)
  host.repos.subscriptions.remove(threadKey, ticketId)
}

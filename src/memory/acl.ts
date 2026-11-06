import { UserError } from '../shared/errors.ts'
import { threadKey, type Decision, type ObjectRef, type Thread, type Ticket, type Trigger } from '../shared/types.ts'
import type { Store } from '../store/sqlite.ts'
import { parseHandle, refsForDecision, refsForTicket, refsForTrigger } from './graph.ts'

/** One page. A granted reader still does not receive an unbounded body. */
export const SPILL_PAGE = 200

export function grantTicketSpill(store: Store, spillId: string | undefined, ticketId: string): void {
  if (!spillId) return
  store.grantSpill(spillId, `ticket:${ticketId}`)
  store.grantSpill(spillId, `session:worker_${ticketId}`)
}

export interface SpillPage {
  id: string
  total: number
  offset: number
  text: string
  truncated: boolean
  nextOffset?: number
  /** Next-hop refs inlined for Chain of Recall. Never a grant. */
  refs: ObjectRef[]
}

/**
 * Ticket or session scope is required. A spill id alone is not a capability.
 * The returned text is one page, never the whole object when it is longer.
 */
export function readSpillFor(
  store: Store,
  spillId: string,
  actor: { ticketId?: string; sessionId?: string },
  opts?: { offset?: number; limit?: number },
): SpillPage {
  const body = store.getSpill(spillId)
  if (body == null) throw new UserError(`unknown spill ${spillId}`)
  const grants = store.spillGrants(spillId)
  const allowed = (actor.ticketId != null && grants.includes(`ticket:${actor.ticketId}`))
    || (actor.sessionId != null && grants.includes(`session:${actor.sessionId}`))
  if (!allowed) throw new UserError(`spill ${spillId} is not visible to this session`)
  return page(spillId, body, store.getSpillRefs(spillId), opts)
}

/**
 * Resolve one Chain-of-Recall handle. Spill ids keep the original grant rule;
 * document handles require the reader ticket to own or share the object's
 * Thread. The handle itself never widens access.
 */
export function readObjectFor(
  store: Store,
  handle: string,
  actor: { ticketId?: string; sessionId?: string },
  opts?: { offset?: number; limit?: number },
): SpillPage {
  const id = handle.trim()
  if (store.getSpill(id) != null) return readSpillFor(store, id, actor, opts)
  // Preserve the spill-specific error for unknown ids that look like spills.
  if (/^(?:.*_)?spill_/.test(id)) throw new UserError(`unknown spill ${id}`)
  const parsed = parseHandle(id)
  if (!parsed) throw new UserError(`unknown object ${handle || '(empty)'}`)
  const ticketId = readerTicketId(actor)
  if (parsed.kind === 'memory') {
    const entry = store.getDoc<{ id: string; spillId?: string }>('ltm', parsed.objectId)
    if (!entry?.spillId) throw new UserError(`unknown memory ${parsed.objectId}`)
    return readSpillFor(store, entry.spillId, actor, opts)
  }
  const reader = ticketId ? store.getDoc<Ticket>('ticket', ticketId) : undefined
  switch (parsed.kind) {
    case 'trigger': {
      const trigger = store.getDoc<Trigger>('trigger', parsed.objectId)
      if (!trigger) throw new UserError(`unknown trigger ${parsed.objectId}`)
      requireSharedThread(reader, trigger.threads.map(threadKey), `trigger ${parsed.objectId}`)
      const self = trigger.refs?.find(ref => ref.kind === 'trigger' && ref.id === id)
      const body = self?.spillId ? store.getSpill(self.spillId) : undefined
      return page(id, body ?? trigger.text, trigger.refs ?? refsForTrigger(trigger), opts)
    }
    case 'thread': {
      const thread = store.getDoc<Thread>('thread', parsed.objectId)
      if (!thread) throw new UserError(`unknown thread ${parsed.objectId}`)
      requireSharedThread(reader, [thread.key, ...thread.correlated], `thread ${parsed.objectId}`)
      return page(id, threadText(thread), [refsForThread(thread)], opts)
    }
    case 'ticket': {
      const ticket = store.getDoc<Ticket>('ticket', parsed.objectId)
      if (!ticket) throw new UserError(`unknown ticket ${parsed.objectId}`)
      requireSharedThread(reader, ticket.threadKeys, `ticket ${parsed.objectId}`)
      return page(id, ticketText(ticket), ticket.refs ?? refsForTicket(ticket), opts)
    }
    case 'decision': {
      const decision = store.getDoc<Decision>('decision', parsed.objectId)
      if (!decision) throw new UserError(`unknown decision ${parsed.objectId}`)
      requireSharedThread(reader, [decision.threadKey], `decision ${parsed.objectId}`)
      return page(id, decisionText(decision), decision.refs ?? refsForDecision(decision), opts)
    }
    case 'session': {
      requireSession(actor, parsed.objectId)
      const text = store.listMessages(parsed.objectId)
        .slice(-50)
        .map(message => `${message.role}: ${message.body}`)
        .join('\n')
      return page(id, text, [{ kind: 'session', id, label: parsed.objectId }], opts)
    }
    case 'channel':
      requireSharedThread(reader, [parsed.objectId], `channel ${parsed.objectId}`)
      return page(id, `channel=${parsed.objectId}`, [{ kind: 'channel', id, label: parsed.objectId }], opts)
    case 'actor':
      if (!reader) throw new UserError(`object ${parsed.objectId} is not visible to this session`)
      return page(id, `actor=${parsed.objectId}`, [{ kind: 'actor', id, label: parsed.objectId }], opts)
    default:
      throw new UserError(`unknown object ${handle}`)
  }
}

function page(
  id: string,
  body: string,
  refs: readonly ObjectRef[],
  opts?: { offset?: number; limit?: number },
): SpillPage {
  const offset = Math.max(0, Math.floor(opts?.offset ?? 0))
  const asked = opts?.limit == null ? SPILL_PAGE : Math.floor(opts.limit)
  const limit = Math.min(SPILL_PAGE, Math.max(1, asked))
  const text = body.slice(offset, offset + limit)
  const truncated = offset + text.length < body.length
  return {
    id,
    total: body.length,
    offset,
    text,
    truncated,
    nextOffset: truncated ? offset + text.length : undefined,
    refs: [...refs],
  }
}

function readerTicketId(
  actor: { ticketId?: string; sessionId?: string },
): string | undefined {
  if (actor.ticketId?.trim()) return actor.ticketId
  const match = /^worker_(.+)$/.exec(actor.sessionId ?? '')
  return match?.[1]
}

function requireSharedThread(reader: Ticket | undefined, keys: readonly string[], what: string): void {
  if (!reader) throw new UserError(`${what} is not visible to this session`)
  if (reader.threadKeys.some(key => keys.includes(key))) return
  throw new UserError(`${what} is not visible to this ticket`)
}

function requireSession(actor: { ticketId?: string; sessionId?: string }, sessionId: string): void {
  if (actor.sessionId === sessionId) return
  if (actor.ticketId && sessionId === `worker_${actor.ticketId}`) return
  throw new UserError(`session ${sessionId} is not visible to this session`)
}

function refsForThread(thread: Thread): ObjectRef {
  return {
    kind: 'thread',
    id: `thread:${thread.key}`,
    label: thread.key,
    refs: [
      ...thread.subscriptions.map(id => ({ kind: 'ticket' as const, id: `ticket:${id}` })),
      ...thread.correlated.map(key => ({ kind: 'thread' as const, id: `thread:${key}` })),
    ],
  }
}

function ticketText(ticket: Ticket): string {
  return [
    `ticket=${ticket.id}`,
    `title=${ticket.title}`,
    `brief=${ticket.brief}`,
    `threads=${ticket.threadKeys.join(',')}`,
    `state=${ticket.ended ? `ended:${ticket.ended.outcome}` : 'live'}`,
  ].join('\n')
}

function threadText(thread: Thread): string {
  return [
    `thread=${thread.key}`,
    `subscribers=${thread.subscriptions.join(',')}`,
    `correlated=${thread.correlated.join(',')}`,
    `lastAt=${thread.lastAt ?? ''}`,
  ].join('\n')
}

function decisionText(decision: Decision): string {
  return [
    `decision=${decision.id}`,
    `kind=${decision.kind}`,
    `thread=${decision.threadKey}`,
    `triggers=${decision.triggerIds.join(',')}`,
    ...(decision.ticketId ? [`ticket=${decision.ticketId}`] : []),
    `reason=${decision.reason}`,
  ].join('\n')
}

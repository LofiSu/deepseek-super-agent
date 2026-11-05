import { threadKey, type Decision, type ObjectRef, type ObjectRefKind, type Ticket, type Trigger } from '../shared/types.ts'

/**
 * Chain-of-recall nodes (§3.3). Every context object gets one stable handle,
 * and every injected object carries the handles of its tightly related
 * neighbours. A handle is a pointer, not a capability: `read_object` resolves
 * it and re-checks the caller's ticket/thread grants.
 */
export function objectRef(
  kind: ObjectRefKind,
  objectId: string,
  opts: { label?: string; spillId?: string; refs?: readonly ObjectRef[] } = {},
): ObjectRef {
  return {
    kind,
    id: `${kind}:${objectId}`,
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.spillId ? { spillId: opts.spillId } : {}),
    ...(opts.refs?.length ? { refs: [...opts.refs] } : {}),
  }
}

export function spillRef(spillId: string, label?: string): ObjectRef {
  return { kind: 'memory', id: spillId, ...(label ? { label } : {}) }
}

export function threadRef(key: string): ObjectRef {
  return objectRef('thread', key, { label: key })
}

export function ticketRef(id: string, label?: string): ObjectRef {
  return objectRef('ticket', id, { label })
}

export function triggerRef(id: string, label?: string): ObjectRef {
  return objectRef('trigger', id, { label })
}

export function channelRef(source: string, thread: string): ObjectRef {
  return objectRef('channel', `${source}:${thread}`, { label: `${source}:${thread}` })
}

export function actorRef(source: string, id: string): ObjectRef {
  return objectRef('actor', `${source}:${id}`, { label: source })
}

export function sessionRef(sessionId: string): ObjectRef {
  return objectRef('session', sessionId, { label: sessionId })
}

export function decisionRef(id: string, label?: string): ObjectRef {
  return objectRef('decision', id, { label })
}

/** Deduplicate by `kind:id`; later entries win, preserving first position. */
export function mergeRefs(...groups: readonly (readonly ObjectRef[])[]): ObjectRef[] {
  const merged = new Map<string, ObjectRef>()
  for (const group of groups) {
    for (const ref of group) merged.set(`${ref.kind}:${ref.id}`, ref)
  }
  return [...merged.values()]
}

/** One-line model-facing form: `refs=thread:a,ticket:ticket_3`. */
export function formatRefs(refs: readonly ObjectRef[] | undefined): string {
  if (!refs?.length) return ''
  return `refs=${refs.map(ref => ref.id).join(',')}`
}

/** Parse `<kind>:<objectId>` (object ids may contain `:` or `/`). */
export function parseHandle(handle: string): { kind: ObjectRefKind; objectId: string } | undefined {
  const index = handle.indexOf(':')
  if (index <= 0) return undefined
  const kind = handle.slice(0, index)
  const objectId = handle.slice(index + 1)
  if (!objectId) return undefined
  if (!HANDLE_KINDS.has(kind)) return undefined
  return { kind: kind as ObjectRefKind, objectId }
}

const HANDLE_KINDS: ReadonlySet<string> = new Set([
  'trigger', 'thread', 'ticket', 'session', 'channel', 'actor', 'decision', 'memory',
])

/**
 * Refs inlined with a Trigger: its own handle, its Threads, the channel, and
 * the actor. Ingress calls this after redaction, so labels are safe to inline.
 */
export function refsForTrigger(
  trigger: Trigger,
  spillId?: string,
  neighbors: readonly ObjectRef[] = [],
): ObjectRef[] {
  const self = objectRef('trigger', trigger.id, {
    label: trigger.text.replace(/\s+/g, ' ').trim().slice(0, 80),
    spillId,
  })
  return mergeRefs(
    [self],
    trigger.threads.map(ref => threadRef(threadKey(ref))),
    trigger.channel ? [channelRef(trigger.channel.source, trigger.channel.thread)] : [],
    [actorRef(trigger.actor.source, trigger.actor.id)],
    neighbors,
  )
}

/** Refs inlined with a Ticket: itself, its Threads, origin Trigger, session, channels. */
export function refsForTicket(ticket: Ticket): ObjectRef[] {
  return mergeRefs(
    [ticketRef(ticket.id, ticket.title)],
    ticket.threadKeys.map(threadRef),
    [triggerRef(ticket.originTriggerId), sessionRef(`worker_${ticket.id}`)],
    ticket.channels.map(channel => channelRef(channel.source, channel.thread)),
  )
}

/** Refs inlined with a Router decision: decision, thread, ticket, triggers. */
export function refsForDecision(decision: Decision): ObjectRef[] {
  return mergeRefs(
    [decisionRef(decision.id, `${decision.kind} ${decision.threadKey}`)],
    [threadRef(decision.threadKey)],
    decision.ticketId ? [ticketRef(decision.ticketId)] : [],
    decision.triggerIds.map(id => triggerRef(id)),
  )
}

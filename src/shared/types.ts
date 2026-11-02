export type Role = 'router' | 'worker' | 'watchdog'

export type ReceiveResult = 'stored' | 'duplicate' | 'filtered'

export type Strength = 'explicit' | 'inferred' | 'maybe'

export type DecisionKind = 'accept' | 'ignore' | 'stop' | 'unavailable'

export interface ActorRef {
  source: string
  id: string
}

export interface ThreadRef {
  source: string
  id: string
}

export interface ChannelRef {
  source: string
  thread: string
  address?: Record<string, string>
}

/**
 * One immutable event from a source. `text` and `meta` are untrusted.
 * The Engine never reads a decision from `meta`; see `TriggerTrust`.
 */
export interface Trigger {
  id: string
  source: string
  threads: ThreadRef[]
  actor: ActorRef
  human: boolean
  addressed?: 'mention' | 'direct'
  /**
   * Channel-adapter hint: evaluate this as low-confidence work that stays silent
   * until a deliver gate commits it. It can make an actionable-looking text
   * speculative, but it never admits noise and is not read from `meta`.
   */
  speculate?: boolean
  at: string
  text: string
  channel?: ChannelRef
  meta: Record<string, unknown>
}

export function threadKey(ref: ThreadRef): string {
  return `${ref.source}:${ref.id}`
}

/**
 * Ingress-owned facts for one receive. The Runtime builds this next to the
 * trigger it just filtered; it is deliberately separate from `trigger.meta`,
 * which is untrusted and may be set by any channel adapter or caller.
 */
export interface TriggerTrust {
  /** Spill the ingress layer itself created for this trigger. The only grant source. */
  spillId?: string
  /** Strength the ingress filter derived. Never copied from `meta.strength`. */
  strength?: Strength
  /**
   * The redacted text the ingress filter actually classified. When the body was
   * spilled, `trigger.text` is only a summary; the Engine must assess the same
   * bytes rather than re-filter a truncated prefix.
   */
  filterText?: string
  /** Router shard ids. Computed by the ingress layer, never read from `meta`. */
  shards?: string[]
}

export interface Thread {
  key: string
  ref: ThreadRef
  createdAt: string
  lastAt?: string
  subscriptions: string[]
  /** Per-subscription flags. A contextOnly subscriber does not get a follow-up bypass. */
  subscriptionMeta?: Record<string, { contextOnly?: boolean; at?: string }>
  correlated: string[]
  pending: string[]
  meta: Record<string, unknown>
}

export interface Disposition {
  filtered?: string
  fanout: string[]
  /** Router shards that matched this trigger. */
  shards?: string[]
  handbacks?: { ticketId: string; reason: string; at: string }[]
  at: string
}

export interface Mandate {
  strength: Strength
  policyVersion: string
  scope: string
  actor: ActorRef
  basis: string
}

export interface Assignment {
  id: string
  state: 'pending' | 'running' | 'ended'
  speculative: boolean
  workerSessionId?: string
  /** Worker mesh node that owns this assignment. Logical placement only. */
  node?: string
  startedAt?: string
  endedAt?: string
  report?: {
    kind: string
    text: string
    deliver?: boolean
    verdict?: 'deliver' | 'discard' | 'hold'
    /** When the report was recorded. A progress report is a heartbeat, not a terminal stop. */
    at?: string
  }
}

export interface TicketInput {
  id: string
  kind: 'trigger' | 'text' | 'job'
  triggerId?: string
  text?: string
  spillId?: string
  at: string
  human?: boolean
}

/** One human guidance note injected into the next Router/Worker turn. */
export interface Guidance {
  id: string
  at: string
  actor: string
  text: string
  /** Set once a Worker turn has received this note. */
  seenByWorker?: boolean
  /** Set once a Router turn has received this note. */
  seenByRouter?: boolean
}

export interface PauseState {
  at: string
  by: string
  reason?: string
}

export interface ResumeRecord {
  at: string
  by: string
  reason?: string
  /** Pause this resume ended; follow-up inputs after this point continue the task. */
  pausedAt?: string
}

/**
 * Mid-task collaboration state for one Ticket. Persisted with the Ticket document
 * in SQLite, so pause/guidance/resume survive a process restart.
 */
export interface Collaboration {
  paused?: PauseState
  guidance: Guidance[]
  resumes: ResumeRecord[]
}

export interface TicketEnd {
  at: string
  outcome: string
  by: 'executor' | 'human' | 'watchdog' | 'router'
}

export interface Ticket {
  id: string
  title: string
  brief: string
  spillId?: string
  mandate: Mandate
  threadKeys: string[]
  channels: ChannelRef[]
  inputs: TicketInput[]
  assignments: Assignment[]
  speculative: boolean
  originTriggerId: string
  createdAt: string
  ended?: TicketEnd
  /** Mid-task pause / human guidance / resume state. Absent means untouched. */
  collab?: Collaboration
}

export interface Decision {
  id: string
  evalId: string
  threadKey: string
  triggerIds: string[]
  kind: DecisionKind
  ticketId?: string
  at: string
  reason: string
  strength: Strength
}

export interface ReplyRow {
  id: string
  ticketId: string
  channel: string
  purpose: string
  text: string
  status: 'pending' | 'sent' | 'dropped'
  createdAt: string
}

/**
 * Durable outbound queue. `Replies` writes here inside the Engine transaction;
 * a channel adapter (Feishu message API, GitHub issue/PR comment API) drains it.
 */
export interface OutboxRow {
  id: string
  replyId: string
  ticketId: string
  /** Channel norms key: `im`, `github`, `cli`. */
  channel: string
  /** Thread key as stored on the ticket (`github:issue:12`, `im:feishu:oc_...`). */
  thread: string
  /** Delivery address copied from `ChannelRef.address` (repo/issue or chat_id/message_id). */
  target: Record<string, string>
  text: string
  status: 'pending' | 'sent' | 'failed'
  externalId?: string
  error?: string
  createdAt: string
  sentAt?: string
}

export interface JobRow {
  id: string
  sessionId: string
  ticketId: string
  name: string
  status: 'running' | 'succeeded' | 'failed' | 'stopped'
  createdAt: string
  finishedAt?: string
}

export interface SessionRow {
  id: string
  role: Role
  ticketId?: string
  status: 'running' | 'idle'
  heartbeat: string
  createdAt: string
}

export function liveTicket(ticket: Ticket): boolean {
  return ticket.ended == null
}

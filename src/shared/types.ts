/** Domain types. Glossary-aligned; no harness runtime. */

export type SessionRole = 'router' | 'worker' | 'watchdog'

export type DecisionKind = 'accept' | 'stop' | 'ignore' | 'unavailable'
export type Strength = 'explicit' | 'inferred'
export type AssignmentState = 'pending' | 'running' | 'ended'
export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'
export type TicketStatus = 'open' | 'ended'
export type ReceiveResult = 'stored' | 'duplicate' | 'filtered'
export type JobStatus = 'started' | 'done' | 'failed'

export interface ActorRef {
  source: string
  id: string
}

export interface ThreadRef {
  source: string
  id: string
}

/** Write side of a Thread. Address format belongs to the Source. */
export interface ChannelRef {
  source: string
  thread: string
  address: Record<string, string>
}

/** A stream of events: kind plus one instance configuration. */
export interface Source {
  id: string
  kind: string
  enabled: boolean
  cursor?: string
}

/** One immutable event from a Source. */
export interface Trigger {
  id: string
  source: string
  threads: ThreadRef[]
  actor: ActorRef
  human: boolean
  at: string
  text: string
  channel?: ChannelRef
  meta: Record<string, unknown>
}

/** Judgement on a batch of Triggers. Holds no durable state of its own. */
export interface Eval {
  id: string
  threadKey: string
  triggerIds: string[]
  strength: Strength
  policyVersion: string
  startedAt: string
  /** When this passes without a Decision, the Eval is recorded unavailable. */
  deadline?: string
}

/** Triggers in time order. At most one Eval runs on it at a time. */
export interface Thread {
  key: string
  ref: ThreadRef
  createdAt: string
  lastAt?: string
  subscriptions: string[]
  pending: string[]
  evaluating?: Eval
  meta: Record<string, unknown>
}

/** What an accept grants. Immutable. */
export interface Mandate {
  strength: Strength
  policyVersion: string
  actor: ActorRef
  scope: string
}

/** Result of an Eval. */
export interface Decision {
  id: string
  evalId: string
  threadKey: string
  triggerIds: string[]
  policyVersion: string
  at: string
  kind: DecisionKind
  strength: Strength
  ticketId?: string
  mandate?: Mandate
  reason?: string
}

export interface Channel {
  ref: ChannelRef
  ticketId?: string
}

/** Ticket–Thread relation held by the Thread. */
export interface Subscription {
  threadKey: string
  ticketId: string
  context?: boolean
}

export interface Report {
  state: ReportState
  summary: string
  at: string
}

/** Binding of a Ticket to one executor instance. */
export interface Assignment {
  id: string
  ticketId: string
  state: AssignmentState
  createdAt: string
  startedAt?: string
  endedAt?: string
  endedReason?: string
  report?: Report
}

export interface TicketEnd {
  at: string
  by: 'executor' | 'human'
  outcome: 'completed' | 'dropped' | 'stopped' | 'failed'
  reason?: string
}

export interface TicketInput {
  id: string
  kind: 'trigger' | 'resumed' | 'text'
  at: string
  triggerId?: string
  text?: string
  human?: boolean
  deliveredAt?: string
}

/** A unit of authorized work. Only Eval creates one. */
export interface Ticket {
  id: string
  title: string
  decisionId: string
  mandate: Mandate
  channels: ChannelRef[]
  status: TicketStatus
  assignments: Assignment[]
  createdAt: string
  updatedAt: string
  ended?: TicketEnd
  inputs?: TicketInput[]
  /** Input ids not yet handed to the running Assignment. */
  undelivered?: string[]
}

/** Offloaded body. Inline keeps the summary and these ids. */
export interface Spill {
  id: string
  summary: string
  createdAt: string
}

/** Inline memory: summary plus spill ids. Bodies live in the spill store. */
export interface Inline {
  summary: string
  spillIds: string[]
}

export type SpillBody = string | Uint8Array | Record<string, unknown>

export interface SpillRecord extends Spill {
  encoding: 'text' | 'json' | 'bytes'
  /** Text, JSON source, or base64 for bytes. */
  body: string
}

export type ReplyKind = 'acknowledgement' | 'answer' | 'result' | 'attention'
export type ReplyStatus = 'pending' | 'sent' | 'dropped'

export interface OutboundMessage {
  id: string
  channel: ChannelRef
  text: string
  kind: ReplyKind
  ticketId?: string
}

/** Async tool work. A tool may return `{ status: 'started', jobId }`. */
export interface Job {
  id: string
  sessionId: string
  status: JobStatus
}

export interface ToolStart {
  status: 'started'
  jobId: string
}

export function isToolStart(value: unknown): value is ToolStart {
  if (!value || typeof value !== 'object') return false
  const record = value as { status?: unknown; jobId?: unknown }
  return record.status === 'started' && typeof record.jobId === 'string'
}

export const threadKey = (ref: ThreadRef): string => `${ref.source}:${ref.id}`

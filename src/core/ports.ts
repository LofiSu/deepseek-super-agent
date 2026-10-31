import type { Outbox, Repositories } from '../shared/ports.js'
import type {
  Assignment,
  DecisionKind,
  Eval,
  Strength,
  Ticket,
  Thread,
  Trigger,
} from '../shared/types.js'
import type { DomainEvent } from '../shared/events.js'

export type GateResult =
  | { admissible: false; reason: string }
  | { admissible: true; strength: Strength; policyVersion: string }

/** Deterministic first layer of Eval. */
export interface Gate {
  admit(trigger: Trigger, thread: Thread, tickets: Ticket[]): GateResult
}

export interface AssessmentInput {
  evaluation: Eval
  triggers: Trigger[]
  thread: Thread
  tickets: Ticket[]
}

/** Model judgement. `undefined` leaves the Eval open until `decide` or its deadline. */
export interface Assessment {
  kind: DecisionKind
  title?: string
  scope?: string
  ticketId?: string
  reason?: string
}

export interface Assessor {
  assess(input: AssessmentInput): Assessment | undefined
}

/** Runs Assignments outside the domain. Called only after the transaction commits. */
export interface Executor {
  start(ticket: Ticket, assignment: Assignment): void
  deliver?(ticket: Ticket, assignment: Assignment, inputIds: string[]): void
  stop?(ticket: Ticket, assignment: Assignment, reason: string): void
}

export interface EngineHost {
  repos: Repositories
  gate: Gate
  assessor: Assessor
  executor: Executor
  outbox: Outbox
  now(): string
  id(prefix: string): string
  evalTimeoutMs: number
  policyVersion: string
  filter(trigger: Trigger): boolean
  effects: Array<() => void>
  emit(event: DomainEvent): void
  logFanout(ticketId: string, triggerId: string): void
}

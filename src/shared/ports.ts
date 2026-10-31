import type {
  Assignment,
  Channel,
  Decision,
  Eval,
  Job,
  Mandate,
  OutboundMessage,
  ReceiveResult,
  ReplyStatus,
  SessionRole,
  Source,
  SpillBody,
  SpillRecord,
  Subscription,
  Ticket,
  ToolStart,
  Trigger,
  Thread,
} from './types.js'

/** Engine.receive → stored | duplicate | filtered. Domain rules stay in the engine. */
export interface Engine {
  receive(trigger: Trigger): ReceiveResult
}

export interface TurnResult {
  sessionId: string
  status: 'done' | 'waiting' | 'stopped'
  started: ToolStart[]
}

/** Harness.runTurn. Tools may return a started Job and must not block the loop. */
export interface Harness {
  runTurn(sessionId: string): Promise<TurnResult>
}

export interface SessionRef {
  id: string
  role: SessionRole
}

/**
 * spill.put → id. `readObject` returns the stored body.
 * Inline callers keep `{ summary, spillIds }` and do not inline the body.
 */
export interface SpillStore {
  put(body: SpillBody, summary?: string): string
  get(id: string): SpillRecord | undefined
  readObject(id: string): unknown
}

export interface JobQueue {
  start(sessionId: string): Job
}

/** Synchronous repositories so `atomic` can wrap one unit of work. No domain rules. */
export interface Repositories {
  atomic<T>(work: () => T): T
  sources: {
    get(id: string): Source | undefined
    save(source: Source): void
    list(): Source[]
  }
  triggers: {
    get(id: string): Trigger | undefined
    save(trigger: Trigger): void
    list(): Trigger[]
  }
  threads: {
    get(key: string): Thread | undefined
    save(thread: Thread): void
    list(): Thread[]
  }
  evals: {
    get(id: string): Eval | undefined
    save(evaluation: Eval): void
    byThread(threadKey: string): Eval[]
  }
  mandates: {
    get(ticketId: string): Mandate | undefined
    save(ticketId: string, mandate: Mandate): void
  }
  tickets: {
    get(id: string): Ticket | undefined
    save(ticket: Ticket): void
    list(): Ticket[]
    open(): Ticket[]
  }
  assignments: {
    get(id: string): Assignment | undefined
    save(assignment: Assignment): void
    byTicket(ticketId: string): Assignment[]
  }
  subscriptions: {
    save(subscription: Subscription): void
    remove(threadKey: string, ticketId: string): void
    byThread(threadKey: string): Subscription[]
    byTicket(ticketId: string): Subscription[]
  }
  channels: {
    save(channel: Channel): void
    list(): Channel[]
    byTicket(ticketId: string): Channel[]
  }
  decisions: {
    get(id: string): Decision | undefined
    save(decision: Decision): void
    byThread(threadKey: string): Decision[]
  }
  spill: SpillStore
  jobs: {
    get(id: string): Job | undefined
    save(job: Job): void
    bySession(sessionId: string): Job[]
  }
}

/** Channel writes. Kinds: acknowledgement, answer, result, attention. */
export interface Outbox {
  send(message: OutboundMessage): void
  status(id: string): ReplyStatus | undefined
  withdraw(id: string): void
}

export interface EnvRunOptions {
  /** Relative to the sandbox workdir. Absolute paths and `..` escapes are rejected. */
  cwd?: string
  timeoutMs?: number
}

export interface EnvRunResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** Execution environment. Holds a workdir and a shell, not domain state. */
export interface Env {
  readonly workdir: string
  run(command: string, options?: EnvRunOptions): Promise<EnvRunResult>
}

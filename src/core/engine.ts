import { randomUUID } from 'node:crypto'
import { AgentError } from '../shared/errors.js'
import type { DomainEvent, SubscriptionFanout } from '../shared/events.js'
import type { Engine as EnginePort, Outbox, Repositories } from '../shared/ports.js'
import type { ReceiveResult, ReplyKind, Report, Trigger } from '../shared/types.js'
import { assignmentInterrupted, assignmentStarted, inputsDelivered, reportAssignment } from './assignments.js'
import { decide, evaluateDue } from './evals.js'
import { receive } from './intake.js'
import type { Assessment, Assessor, EngineHost, Executor, Gate } from './ports.js'
import { queueReply } from './replies.js'
import { subscribe, unsubscribe } from './subscribe.js'
import { loadTicket, retryTicket, stopTicket } from './tickets.js'

export interface EngineOptions {
  repos: Repositories
  gate: Gate
  assessor: Assessor
  executor: Executor
  outbox: Outbox
  now?: () => string
  id?: (prefix: string) => string
  evalTimeoutMs?: number
  policyVersion?: string
  filter?: (trigger: Trigger) => boolean
}

/** Sole writer of Triggers, Threads, Decisions, Tickets, Assignments, and Subscriptions. */
export class Engine implements EnginePort {
  readonly events: DomainEvent[] = []
  readonly fanouts: SubscriptionFanout[] = []
  private readonly host: EngineHost
  private pendingEvents: DomainEvent[] = []
  private pendingFanouts: SubscriptionFanout[] = []

  constructor(options: EngineOptions) {
    const id = options.id ?? ((prefix: string) => `${prefix}-${randomUUID()}`)
    this.host = {
      repos: options.repos,
      gate: options.gate,
      assessor: options.assessor,
      executor: options.executor,
      outbox: options.outbox,
      now: options.now ?? (() => new Date().toISOString()),
      id,
      evalTimeoutMs: options.evalTimeoutMs ?? 60_000,
      policyVersion: options.policyVersion ?? '0',
      filter: options.filter ?? (() => true),
      effects: [],
      emit: event => {
        this.pendingEvents.push(event)
      },
      logFanout: (ticketId, triggerId) => {
        const line: SubscriptionFanout = {
          type: 'subscription.fanout',
          bypass: 'subscription',
          ticketId,
          triggerId,
          at: this.host.now(),
        }
        this.pendingFanouts.push(line)
        this.pendingEvents.push({ type: 'subscription.fanout', at: line.at, data: line })
      },
    }
  }

  receive(trigger: Trigger): ReceiveResult {
    return this.unit(() => receive(this.host, trigger))
  }

  evaluateDue(): void {
    this.unit(() => evaluateDue(this.host))
  }

  decide(evalId: string, assessment: Assessment): void {
    this.unit(() => decide(this.host, evalId, assessment))
  }

  assignmentStarted(ticketId: string, assignmentId: string): void {
    this.unit(() => assignmentStarted(this.host, ticketId, assignmentId))
  }

  inputsDelivered(ticketId: string, assignmentId: string, inputIds: readonly string[]): void {
    this.unit(() => inputsDelivered(this.host, ticketId, assignmentId, inputIds))
  }

  report(ticketId: string, assignmentId: string, report: Report): void {
    this.unit(() => reportAssignment(this.host, ticketId, assignmentId, report))
  }

  assignmentInterrupted(ticketId: string, assignmentId: string): void {
    this.unit(() => assignmentInterrupted(this.host, ticketId, assignmentId))
  }

  stopTicket(ticketId: string, reason?: string): void {
    this.unit(() => stopTicket(this.host, ticketId, reason))
  }

  retryTicket(ticketId: string): void {
    this.unit(() => retryTicket(this.host, ticketId))
  }

  reply(ticketId: string, kind: ReplyKind, text: string): void {
    this.unit(() => queueReply(this.host, loadTicket(this.host, ticketId), kind, text, true))
  }

  subscribe(threadKey: string, ticketId: string, context = false): void {
    this.unit(() => {
      const thread = this.host.repos.threads.get(threadKey)
      if (!thread) throw new AgentError('thread_missing', threadKey)
      loadTicket(this.host, ticketId)
      subscribe(this.host, thread, ticketId, context)
    })
  }

  unsubscribe(threadKey: string, ticketId: string): void {
    this.unit(() => unsubscribe(this.host, threadKey, ticketId))
  }

  private unit<T>(work: () => T): T {
    const effects: Array<() => void> = []
    const previous = this.host.effects
    this.host.effects = effects
    this.pendingEvents = []
    this.pendingFanouts = []
    let committed = false
    try {
      const value = this.host.repos.atomic(work)
      committed = true
      this.events.push(...this.pendingEvents)
      this.fanouts.push(...this.pendingFanouts)
      for (const effect of effects) effect()
      return value
    } finally {
      if (!committed) {
        this.pendingEvents = []
        this.pendingFanouts = []
      }
      this.host.effects = previous
    }
  }
}

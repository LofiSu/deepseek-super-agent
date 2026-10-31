import { maySurface } from '../speculate/gate.ts'
import type { Decision, ReceiveResult, Ticket, Trigger } from '../shared/types.ts'
import { Assignments, type ReportResult, type WorkerReport } from './assignments.ts'
import { Evals } from './evals.ts'
import type { Host } from './host.ts'
import { Intake } from './intake.ts'
import { Replies } from './replies.ts'
import { handback } from './subscribe.ts'
import { Tickets } from './tickets.ts'

/**
 * Synchronous domain commands. Each public method is one transaction.
 * Harness, sources, and the watchdog call in; they do not own these rules.
 */
export class Engine {
  private readonly intake: Intake
  private readonly evals: Evals
  private readonly tickets: Tickets
  private readonly assignments: Assignments
  private readonly replies: Replies

  constructor(private readonly host: Host) {
    this.replies = new Replies(host)
    this.tickets = new Tickets(host, this.replies)
    this.assignments = new Assignments(host)
    this.intake = new Intake(host)
    this.evals = new Evals(host, this.tickets)
  }

  receive(trigger: Trigger): ReceiveResult {
    return this.host.repo.atomic(() => this.intake.receive(trigger))
  }

  evaluateDue(): Decision[] {
    return this.host.repo.atomic(() => this.evals.evaluateDue())
  }

  assignmentStarted(ticketId: string, assignmentId: string, sessionId: string): void {
    this.host.repo.atomic(() => this.assignments.start(ticketId, assignmentId, sessionId))
  }

  report(ticketId: string, report: WorkerReport): ReportResult {
    return this.host.repo.atomic(() => this.assignments.report(ticketId, report))
  }

  /**
   * DeliverGate clears `speculative` only when a report may surface.
   * Until that commit, maySurface keeps the reply off the outbox.
   */
  reply(ticketId: string, text: string, purpose: string): void {
    this.host.repo.atomic(() => {
      const ticket = this.host.repo.getDoc<Ticket>('ticket', ticketId)
      if (!ticket) throw new Error(`unknown ticket ${ticketId}`)
      const deliver = ticket.speculative ? false : undefined
      if (!maySurface(ticket.speculative, deliver)) {
        this.host.log(`[speculate] reply held ticketId=${ticket.id} purpose=${purpose}`)
        return
      }
      this.replies.send(ticket, text, purpose)
    })
  }

  subscribe(ticketId: string, threadKey: string): void {
    this.host.repo.atomic(() => this.tickets.subscribe(ticketId, threadKey))
  }

  handback(ticketId: string, triggerId: string, reason: string): boolean {
    return this.host.repo.atomic(() => handback(this.host, ticketId, triggerId, reason))
  }
}

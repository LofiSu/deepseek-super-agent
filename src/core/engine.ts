import { maySurface } from '../speculate/gate.ts'
import type { AssessmentOutcome, WorkerReport } from '../shared/ports.ts'
import type { Decision, ReceiveResult, Ticket, Trigger } from '../shared/types.ts'
import { Assignments, type ReportResult } from './assignments.ts'
import {
  Collaborations,
  type CollaborationView,
  type InterveneInput,
  type InterveneOutcome,
  type PauseInput,
  type PauseOutcome,
  type ResumeOutcome,
} from './collab.ts'
import { Evals } from './evals.ts'
import type { Host } from './host.ts'
import { Intake } from './intake.ts'
import { Replies } from './replies.ts'
import { assertSessionMay } from './session-role.ts'
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
  private readonly collaborations: Collaborations

  constructor(private readonly host: Host) {
    this.replies = new Replies(host)
    this.tickets = new Tickets(host, this.replies)
    this.assignments = new Assignments(host)
    this.intake = new Intake(host)
    this.evals = new Evals(host, this.tickets)
    this.collaborations = new Collaborations(host)
  }

  receive(trigger: Trigger): ReceiveResult {
    assertSessionMay('receive')
    return this.host.repo.atomic(() => this.intake.receive(trigger))
  }

  /** Record the router's assessment. Workers and the watchdog cannot call this. */
  decide(triggerId: string, outcome: AssessmentOutcome): Decision {
    assertSessionMay('decide')
    return this.host.repo.atomic(() => this.evals.decide(triggerId, outcome))
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

  /** Freeze a live ticket. Router turns, Worker turns, reports, and replies stop. */
  pause(ticketId: string, input: PauseInput = {}): PauseOutcome {
    return this.host.repo.atomic(() => this.collaborations.pause(ticketId, input))
  }

  /** Record human guidance. By default the ticket pauses so the note lands before more work. */
  intervene(ticketId: string, text: string, input: InterveneInput = {}): InterveneOutcome {
    return this.host.repo.atomic(() => this.collaborations.intervene(ticketId, text, input))
  }

  /** Clear the pause. The Harness resumes the Router/Worker turns after this commit. */
  resume(ticketId: string, input: PauseInput = {}): ResumeOutcome {
    return this.host.repo.atomic(() => this.collaborations.resume(ticketId, input))
  }

  /** Read and mark unseen guidance for one audience. Used by the Harness prompt builder. */
  takeGuidance(ticketId: string, audience: 'worker' | 'router'): string[] {
    return this.host.repo.atomic(() => this.collaborations.takeGuidance(ticketId, audience))
  }

  collaboration(ticketId: string): CollaborationView {
    return this.host.repo.atomic(() => this.collaborations.view(ticketId))
  }

  /**
   * DeliverGate clears `speculative` only when a report may surface.
   * Until that commit, maySurface keeps the reply off the outbox.
   */
  reply(ticketId: string, text: string, purpose: string): void {
    assertSessionMay('reply')
    this.host.repo.atomic(() => {
      const ticket = this.host.repo.getDoc<Ticket>('ticket', ticketId)
      if (!ticket) throw new Error(`unknown ticket ${ticketId}`)
      if (ticket.collab?.paused) {
        this.host.log(`[collab] reply held ticketId=${ticket.id} purpose=${purpose}`)
        this.host.repo.addEvent('collab.reply_held', {
          ticketId: ticket.id,
          purpose,
          pausedAt: ticket.collab.paused.at,
        })
        return
      }
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

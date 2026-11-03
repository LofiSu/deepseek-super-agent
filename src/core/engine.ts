import { maySurface } from '../speculate/gate.ts'
import type { AssessmentOutcome, WorkerReport } from '../shared/ports.ts'
import type { Decision, ReceiveResult, Ticket, Trigger, TriggerTrust } from '../shared/types.ts'
import { Assignments, type Recovery, type ReportResult } from './assignments.ts'
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

  receive(trigger: Trigger, trust?: TriggerTrust): ReceiveResult {
    assertSessionMay('receive')
    return this.host.repo.atomic(() => this.intake.receive(trigger, trust))
  }

  /** Record the router's assessment. Workers and the watchdog cannot call this. */
  decide(triggerId: string, outcome: AssessmentOutcome): Decision {
    assertSessionMay('decide')
    return this.host.repo.atomic(() => this.evals.decide(triggerId, outcome))
  }

  /** End a live ticket on the Router's instruction. Workers and the watchdog cannot call this. */
  stop(ticketId: string, reason: string): void {
    assertSessionMay('stop')
    this.host.repo.atomic(() => this.tickets.stop(ticketId, reason, 'router'))
  }

  evaluateDue(): Decision[] {
    return this.host.repo.atomic(() => this.evals.evaluateDue())
  }

  /** Commit a Router assessment against precisely the queued trigger snapshot. */
  commitAssessed(threadKey: string, triggerIds: string[], outcome: AssessmentOutcome): Decision | undefined {
    assertSessionMay('decide')
    return this.host.repo.atomic(() => this.evals.commitAssessed(threadKey, triggerIds, outcome))
  }

  assignmentStarted(ticketId: string, assignmentId: string, sessionId: string): void {
    this.host.repo.atomic(() => this.assignments.start(ticketId, assignmentId, sessionId))
  }

  /** Persist the Harness's logical mesh placement; the Engine owns the write. */
  assignmentPlaced(ticketId: string, assignmentId: string, node: string): void {
    this.host.repo.atomic(() => this.assignments.placed(ticketId, assignmentId, node))
  }

  report(ticketId: string, report: WorkerReport): ReportResult {
    return this.host.repo.atomic(() => this.assignments.report(ticketId, report))
  }

  /** Start a new Assignment on the same Ticket after a failed or blocked turn. */
  retryTicket(ticketId: string, reason = 'retry'): void {
    this.host.repo.atomic(() => { this.assignments.retry(ticketId, reason) })
  }

  /**
   * Startup-only restart recovery (ADR-004). Persisted SQLite state is the
   * source of truth: every open, unpaused Ticket with a `running` Assignment is
   * ended, gets one RECOVERED context input, and gets one pending replacement
   * Assignment. Safe to call repeatedly; a recovered Ticket no longer matches.
   */
  recoverInterrupted(): Recovery[] {
    return this.host.repo.atomic(() => {
      const recovered: Recovery[] = []
      for (const ticket of this.host.repo.listDocs<Ticket>('ticket')) {
        // One malformed Ticket must not roll back recovery for the others.
        try {
          if (ticket.ended || ticket.collab?.paused) continue
          if (ticket.assignments.some(assignment => assignment.state === 'running')) {
            const outcome = this.assignments.recover(ticket.id)
            if (outcome) recovered.push(outcome)
            continue
          }
          const pending = this.assignments.pendingRecovery(ticket.id)
          if (pending) recovered.push(pending)
        } catch (error) {
          const id = typeof ticket?.id === 'string' ? ticket.id : '-'
          this.host.log(
            `[recovery] ticket failed ticketId=${id} error=${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      return recovered
    })
  }

  /** Watchdog-only failure. Separate from worker reports so `watchdog.fail` stays accurate. */
  watchdogFail(ticketId: string, reason: string): ReportResult {
    return this.host.repo.atomic(() => this.assignments.report(ticketId, {
      kind: 'failed',
      text: reason,
      deliver: false,
    }, 'watchdog'))
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
  reply(ticketId: string, text: string, purpose: string, threadKey?: string): void {
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
      // A ticket that was speculative when it stopped never passed the delivery
      // gate. Stopping clears `speculative` for visibility, so the end record
      // carries `silent` and only that blocks a reply; a normal stopped ticket
      // may still report partial findings.
      if (ticket.ended?.silent === true) {
        this.host.log(`[engine] reply held ticketId=${ticket.id} purpose=${purpose} ended=${ticket.ended.outcome}`)
        this.host.repo.addEvent('collab.reply_held', {
          ticketId: ticket.id,
          purpose,
          reason: 'ended-speculative',
          outcome: ticket.ended.outcome,
        })
        return
      }
      const deliver = ticket.speculative ? false : undefined
      if (!maySurface(ticket.speculative, deliver)) {
        this.host.log(`[speculate] reply held ticketId=${ticket.id} purpose=${purpose}`)
        return
      }
      this.replies.send(ticket, text, purpose, threadKey)
    })
  }

  subscribe(ticketId: string, threadKey: string, opts: { contextOnly?: boolean } = {}): void {
    this.host.repo.atomic(() => this.tickets.subscribe(ticketId, threadKey, opts))
  }

  unsubscribe(ticketId: string, threadKey: string, reason?: string): boolean {
    return this.host.repo.atomic(() => this.tickets.unsubscribe(ticketId, threadKey, reason))
  }

  /** Subscribe for context only: readable, never a wake-up or follow-up bypass. */
  followForContext(ticketId: string, threadKey: string): void {
    this.subscribe(ticketId, threadKey, { contextOnly: true })
  }

  handback(ticketId: string, triggerId: string, reason: string): boolean {
    return this.host.repo.atomic(() => handback(this.host, ticketId, triggerId, reason))
  }
}

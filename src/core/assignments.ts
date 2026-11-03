import { HeuristicDeliverGate, type DeliverGate } from '../speculate/gate.ts'
import type { SurfaceVerdict } from '../speculate/silent.ts'
import { UserError } from '../shared/errors.ts'
import type { WorkerReport } from '../shared/ports.ts'
import type { Assignment, Ticket } from '../shared/types.ts'
import type { Host } from './host.ts'

export type { WorkerReport }

export interface ReportResult {
  surfaced: boolean
  verdict: SurfaceVerdict
}

const TERMINAL = new Set(['ready', 'failed', 'dropped'])

/** Who is reporting. Only the watchdog counts toward `watchdog.fail`. */
export type ReportOrigin = 'worker' | 'watchdog'

export class Assignments {
  private readonly gate: DeliverGate

  constructor(private readonly host: Host, gate?: DeliverGate) {
    this.gate = gate ?? new HeuristicDeliverGate()
  }

  start(ticketId: string, assignmentId: string, sessionId: string): void {
    const ticket = this.must(ticketId)
    const assignment = ticket.assignments.find(item => item.id === assignmentId) ?? ticket.assignments.at(-1)
    if (!assignment) throw new UserError(`ticket ${ticketId} has no assignment`)
    assignment.state = 'running'
    assignment.workerSessionId = sessionId
    assignment.startedAt = this.host.now()
    this.host.repo.putDoc('ticket', ticket.id, ticket)
    this.host.log(`[engine] Assignments.start ticketId=${ticket.id} assignmentId=${assignment.id} session=${sessionId}`)
    this.host.repo.addEvent('assignment.started', { ticketId: ticket.id, assignmentId: assignment.id, sessionId })
  }

  /**
   * Record a report. User-facing text is sent by the router, not here.
   * A speculative discard ends the assignment and the ticket with no outbound copy.
   * Reports on an ended ticket never rewrite it.
   */
  report(ticketId: string, report: WorkerReport, origin: ReportOrigin = 'worker'): ReportResult {
    const ticket = this.must(ticketId)
    const assignment = ticket.assignments.at(-1)
    if (!assignment) throw new UserError(`ticket ${ticketId} has no assignment`)
    if (ticket.ended?.by === 'human') return { surfaced: false, verdict: 'hold' }
    if (ticket.ended) {
      // A late worker report must never reopen or rewrite an ended ticket,
      // even when an earlier stop left a pause in place.
      // The watchdog failing an already-ended ticket is a no-op, not an error.
      if (origin === 'watchdog') {
        this.host.log(`[watchdog] ticket already ended ticketId=${ticket.id} outcome=${ticket.ended.outcome}`)
        return { surfaced: false, verdict: 'hold' }
      }
      throw new UserError(`ticket ${ticketId} has already ended (${ticket.ended.outcome})`)
    }
    if (ticket.collab?.paused) {
      assignment.report = {
        kind: report.kind,
        text: report.text,
        deliver: report.deliver,
        verdict: 'hold',
        at: this.host.now(),
      }
      this.host.repo.putDoc('ticket', ticket.id, ticket)
      this.host.log(`[collab] report held ticketId=${ticket.id} kind=${report.kind}`)
      this.host.repo.addEvent('collab.report_held', {
        ticketId: ticket.id,
        assignmentId: assignment.id,
        kind: report.kind,
        pausedAt: ticket.collab.paused.at,
      })
      return { surfaced: false, verdict: 'hold' }
    }
    const wasSpeculative = ticket.speculative
    const terminal = TERMINAL.has(report.kind)
    let verdict: SurfaceVerdict = 'hold'
    if (wasSpeculative && (terminal || report.deliver === true)) {
      verdict = this.gate.evaluate({ ticket, report })
    } else if (!wasSpeculative && report.deliver === true) {
      verdict = 'deliver'
    }
    assignment.report = {
      kind: report.kind,
      text: report.text,
      deliver: report.deliver,
      verdict,
      at: this.host.now(),
    }
    // A failed Executor report is not a Watchdog failure. Keep both metrics honest.
    if (report.kind === 'failed') {
      if (origin === 'watchdog') this.host.metrics.increment('watchdog.fail')
      else this.host.metrics.increment('executor.fail')
    }

    if (wasSpeculative && verdict === 'hold') {
      this.host.repo.putDoc('ticket', ticket.id, ticket)
      this.host.log(`[speculate] speculative silent ticketId=${ticket.id} deliver=false`)
      return { surfaced: false, verdict }
    }

    if (verdict === 'discard') {
      if (wasSpeculative) this.host.metrics.increment('speculate.discard')
      this.finish(ticket, assignment, report.kind, 'discarded')
      this.host.repo.addEvent('speculate.discarded', {
        ticketId: ticket.id,
        assignmentId: assignment.id,
        kind: report.kind,
      })
      this.host.repo.putDoc('ticket', ticket.id, ticket)
      this.host.log(`[speculate] discarded ticketId=${ticket.id} kind=${report.kind}`)
      return { surfaced: false, verdict }
    }

    if (wasSpeculative && verdict === 'deliver') {
      this.host.metrics.increment('speculate.deliver')
      ticket.speculative = false
      assignment.speculative = false
      this.host.repo.addEvent('speculate.delivered', {
        ticketId: ticket.id,
        assignmentId: assignment.id,
      })
      this.host.log(`[speculate] deliver=true ticketId=${ticket.id}`)
    } else if (report.deliver === true) {
      this.host.log(`deliver=true ticketId=${ticket.id}`)
    }

    if (report.kind === 'ready' || report.kind === 'dropped') {
      this.finish(ticket, assignment, report.kind, report.kind)
    } else if (report.kind === 'failed' || report.kind === 'blocked' || report.kind === 'waiting') {
      // Failure and waiting end the Assignment, not the Ticket. The same Ticket
      // can start a new Assignment later with the same Session and directory.
      this.endAssignment(ticket, assignment, report.kind)
    }
    this.host.repo.putDoc('ticket', ticket.id, ticket)
    const surfaced = wasSpeculative ? verdict === 'deliver' : report.deliver === true
    return { surfaced, verdict }
  }

  /** Start a new Assignment for an open Ticket after failure or a blocked turn. */
  retry(ticketId: string, reason = 'retry'): Assignment {
    const ticket = this.must(ticketId)
    if (ticket.ended) throw new UserError(`ticket ${ticketId} has ended; open a new Ticket instead`)
    const active = ticket.assignments.find(item => item.state !== 'ended')
    if (active) throw new UserError(`ticket ${ticketId} already has an active assignment`)
    const assignment: Assignment = {
      id: this.host.repo.nextId('asg'),
      state: 'pending',
      speculative: ticket.speculative,
    }
    ticket.assignments.push(assignment)
    this.host.repo.putDoc('ticket', ticket.id, ticket)
    this.host.repo.addEvent('assignment.retried', {
      ticketId: ticket.id,
      assignmentId: assignment.id,
      reason,
    })
    this.host.log(`[engine] Assignments.retry ticketId=${ticket.id} assignmentId=${assignment.id} reason=${reason}`)
    return assignment
  }

  private endAssignment(ticket: Ticket, assignment: Assignment, kind: string): void {
    assignment.state = 'ended'
    assignment.endedAt = this.host.now()
    this.host.repo.addEvent('assignment.ended', {
      ticketId: ticket.id,
      assignmentId: assignment.id,
      kind,
    })
    // Releasing the logical Worker slot here is what makes mesh enforcement
    // safe for blocked/failed/waiting, which leave the Ticket open.
    try {
      this.host.onAssignmentEnded?.(ticket.id)
    } catch (error) {
      this.host.log(
        `[hook] hook=assignment-ended ticketId=${ticket.id} error=${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private finish(ticket: Ticket, assignment: Assignment, kind: string, outcome: string): void {
    this.endAssignment(ticket, assignment, kind)
    ticket.ended = {
      at: this.host.now(),
      outcome,
      by: 'executor',
    }
    this.host.repo.addEvent('ticket.ended', { ticketId: ticket.id, outcome })
    try {
      this.host.onTicketEnded?.(ticket)
    } catch (error) {
      this.host.log(`[hook] hook=ended ticketId=${ticket.id} error=${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private must(ticketId: string): Ticket {
    const ticket = this.host.repo.getDoc<Ticket>('ticket', ticketId)
    if (!ticket) throw new UserError(`unknown ticket ${ticketId}`)
    return ticket
  }
}
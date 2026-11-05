import { HeuristicDeliverGate, type DeliverGate } from '../speculate/gate.ts'
import type { SurfaceVerdict } from '../speculate/silent.ts'
import { UserError } from '../shared/errors.ts'
import type { WorkerReport } from '../shared/ports.ts'
import type { Assignment, Ticket } from '../shared/types.ts'
import { pendingApproval } from './collab.ts'
import type { Host } from './host.ts'

export type { WorkerReport }

export interface ReportResult {
  surfaced: boolean
  verdict: SurfaceVerdict
}

/** One Ticket repaired on startup after a process restart (ADR-004). */
export interface Recovery {
  ticketId: string
  /** Assignments that were still `running` when the process died. */
  interruptedAssignmentIds: string[]
  /** The single replacement `pending` assignment queued for the next turn. */
  replacementAssignmentId: string
  /**
   * True when a previous recovery already committed the replacement and the
   * process died before the Worker started. The Runtime relaunches it as-is;
   * no Assignment is created and no RECOVERED prompt is appended.
   */
  relaunchOnly?: boolean
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
   * Persist logical Worker-mesh placement. The Harness decides the node, but
   * only the Engine writes the Assignment aggregate.
   */
  placed(ticketId: string, assignmentId: string, node: string): void {
    const ticket = this.must(ticketId)
    const assignment = ticket.assignments.find(item => item.id === assignmentId) ?? ticket.assignments.at(-1)
    if (!assignment) throw new UserError(`ticket ${ticketId} has no assignment`)
    assignment.node = node
    this.host.repo.putDoc('ticket', ticket.id, ticket)
    this.host.log(`[engine] Assignments.placed ticketId=${ticket.id} assignmentId=${assignment.id} node=${node}`)
    this.host.repo.addEvent('assignment.placed', {
      ticketId: ticket.id,
      assignmentId: assignment.id,
      node,
    })
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
      // Persist the terminal state before observers can release mesh capacity
      // and pump a queued Worker. A hook fired first would let the scheduler
      // re-read the pre-report snapshot and resurrect this Ticket.
      this.host.repo.putDoc('ticket', ticket.id, ticket)
      this.notifyEnded(ticket, true, true)
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

    let assignmentEnded = false
    let ticketEnded = false
    if (report.kind === 'ready' || report.kind === 'dropped') {
      this.finish(ticket, assignment, report.kind, report.kind)
      assignmentEnded = true
      ticketEnded = true
    } else if (report.kind === 'failed' || report.kind === 'blocked' || report.kind === 'waiting') {
      // Failure and waiting end the Assignment, not the Ticket. The same Ticket
      // can start a new Assignment later with the same Session and directory.
      this.endAssignment(ticket, assignment, report.kind)
      assignmentEnded = true
    }
    this.host.repo.putDoc('ticket', ticket.id, ticket)
    // Observers may release capacity and start queued Workers. Fire them only
    // after the terminal state above is durable in the Store snapshot.
    this.notifyEnded(ticket, assignmentEnded, ticketEnded)
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

  /**
   * Restart recovery (ADR-004): end the Assignment left `running` by the dead
   * process, append exactly one RECOVERED context input, then queue exactly one
   * replacement `pending` Assignment through `retry`. Returns undefined when
   * the Ticket is ended, paused, or has nothing interrupted, which makes
   * repeated `Runtime.start()` calls idempotent.
   *
   * The prompt carries only Ticket/Assignment ids from persisted state, never
   * environment or credential values. Completion is at-least-once: prior side
   * effects may already have happened.
   */
  recover(ticketId: string): Recovery | undefined {
    const ticket = this.must(ticketId)
    // An approval wait is intentional: the Worker is stopped on the pending
    // request, not crashed by a process restart. Treat it like a pause.
    if (ticket.ended || ticket.collab?.paused || pendingApproval(ticket)) return undefined
    const interrupted = ticket.assignments.filter(item => item.state === 'running')
    if (interrupted.length === 0) return undefined
    const at = this.host.now()
    for (const assignment of interrupted) {
      assignment.state = 'ended'
      assignment.endedAt = at
      this.host.repo.addEvent('assignment.ended', {
        ticketId: ticket.id,
        assignmentId: assignment.id,
        kind: 'recovered',
      })
    }
    const interruptedAssignmentIds = interrupted.map(assignment => assignment.id)
    ticket.inputs.push({
      id: this.host.repo.nextId('input'),
      kind: 'context',
      text: `RECOVERED: assignment ${interruptedAssignmentIds.join(',')} was interrupted by a process restart. Continue from persisted state and assume prior side effects may already have occurred (at-least-once).`,
      at,
      human: false,
    })
    // Commit the ended Assignment and the recovered prompt before creating the
    // single pending replacement. A malformed snapshot that already has a
    // pending Assignment keeps it instead of creating a second one.
    this.host.repo.putDoc('ticket', ticket.id, ticket)
    const existing = ticket.assignments.find(item => item.state === 'pending')
    const replacement = existing ?? this.retry(ticket.id, 'restart-recovery')
    this.host.log(
      `[engine] Assignments.recover ticketId=${ticket.id} interrupted=${interruptedAssignmentIds.join(',')} replacementId=${replacement.id}`,
    )
    return {
      ticketId: ticket.id,
      interruptedAssignmentIds,
      replacementAssignmentId: replacement.id,
    }
  }

  /**
   * Crash boundary for at-least-once recovery: a previous recovery committed
   * the ended Assignment, one RECOVERED prompt, and a pending replacement, but
   * the process died before the Worker started. Return the existing pending
   * Assignment so the Runtime can relaunch it without mutating the Ticket.
   * Ordinary pending work (no RECOVERED prompt) is out of scope.
   */
  pendingRecovery(ticketId: string): Recovery | undefined {
    const ticket = this.must(ticketId)
    // A pending approval is a live hold, not a recovery boundary. Relaunching
    // its replacement would start a Worker turn the owner has not released.
    if (ticket.ended || ticket.collab?.paused || pendingApproval(ticket)) return undefined
    if (ticket.assignments.some(item => item.state === 'running')) return undefined
    const latest = ticket.assignments.at(-1)
    if (!latest || latest.state !== 'pending') return undefined
    const recovered = ticket.inputs.some(input =>
      input.kind === 'context' && input.text?.startsWith('RECOVERED:'))
    if (!recovered) return undefined
    return {
      ticketId: ticket.id,
      interruptedAssignmentIds: [],
      replacementAssignmentId: latest.id,
      relaunchOnly: true,
    }
  }

  private endAssignment(ticket: Ticket, assignment: Assignment, kind: string): void {
    assignment.state = 'ended'
    assignment.endedAt = this.host.now()
    this.host.repo.addEvent('assignment.ended', {
      ticketId: ticket.id,
      assignmentId: assignment.id,
      kind,
    })
  }

  private finish(ticket: Ticket, assignment: Assignment, kind: string, outcome: string): void {
    this.endAssignment(ticket, assignment, kind)
    ticket.ended = {
      at: this.host.now(),
      outcome,
      by: 'executor',
    }
    this.host.repo.addEvent('ticket.ended', { ticketId: ticket.id, outcome })
  }

  /**
   * Notify observers after the Ticket document is written. Releasing the
   * logical Worker slot may pump a queued launch, and that launch must observe
   * the committed terminal state rather than the pre-report snapshot.
   */
  private notifyEnded(ticket: Ticket, assignmentEnded: boolean, ticketEnded: boolean): void {
    if (assignmentEnded) {
      try {
        this.host.onAssignmentEnded?.(ticket.id)
      } catch (error) {
        this.host.log(
          `[hook] hook=assignment-ended ticketId=${ticket.id} error=${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    if (ticketEnded) {
      try {
        this.host.onTicketEnded?.(ticket)
      } catch (error) {
        this.host.log(`[hook] hook=ended ticketId=${ticket.id} error=${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private must(ticketId: string): Ticket {
    const ticket = this.host.repo.getDoc<Ticket>('ticket', ticketId)
    if (!ticket) throw new UserError(`unknown ticket ${ticketId}`)
    return ticket
  }
}
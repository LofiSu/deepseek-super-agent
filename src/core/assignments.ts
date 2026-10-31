import { UserError } from '../shared/errors.ts'
import type { Ticket } from '../shared/types.ts'
import { evaluateDeliver, type DeliverDecision } from '../speculate/gate.ts'
import type { Host } from './host.ts'

export interface WorkerReport {
  kind: string
  text: string
  deliver?: boolean
}

export class Assignments {
  constructor(private readonly host: Host) {}

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
   * Record a worker report. User-facing text is sent by the router, not here.
   * Speculative tickets stay hidden until the deliver gate says the report is worth surfacing.
   */
  report(ticketId: string, report: WorkerReport): { surfaced: boolean; gate: DeliverDecision } {
    const ticket = this.must(ticketId)
    const assignment = ticket.assignments.at(-1)
    if (!assignment) throw new UserError(`ticket ${ticketId} has no assignment`)
    const speculative = ticket.speculative
    assignment.report = { kind: report.kind, text: report.text, deliver: report.deliver }
    const gate = evaluateDeliver({
      speculative,
      kind: report.kind,
      text: report.text,
      deliver: report.deliver,
    })
    if (speculative && gate === 'hold') {
      this.host.repo.putDoc('ticket', ticket.id, ticket)
      this.host.log(`[speculate] speculative silent ticketId=${ticket.id} deliver=false`)
      return { surfaced: false, gate }
    }
    if (speculative && gate === 'discard') {
      this.finish(ticket, assignment, report.kind)
      this.host.repo.putDoc('ticket', ticket.id, ticket)
      this.host.log(`[speculate] discard ticketId=${ticket.id} kind=${report.kind}`)
      this.host.repo.addEvent('speculate.discarded', { ticketId: ticket.id, kind: report.kind })
      return { surfaced: false, gate }
    }
    if (speculative && gate === 'deliver') {
      ticket.speculative = false
      assignment.speculative = false
      this.host.log(`[speculate] deliver=true ticketId=${ticket.id}`)
      this.host.repo.addEvent('speculate.delivered', { ticketId: ticket.id })
    } else if (report.deliver === true) {
      this.host.log(`deliver=true ticketId=${ticket.id}`)
    }
    if (report.kind === 'ready' || report.kind === 'dropped' || report.kind === 'failed') {
      this.finish(ticket, assignment, report.kind)
    }
    this.host.repo.putDoc('ticket', ticket.id, ticket)
    return { surfaced: speculative ? gate === 'deliver' : report.deliver === true, gate }
  }

  private finish(ticket: Ticket, assignment: Ticket['assignments'][number], kind: string): void {
    assignment.state = 'ended'
    assignment.endedAt = this.host.now()
    ticket.ended = {
      at: this.host.now(),
      outcome: kind,
      by: kind === 'failed' ? 'watchdog' : 'executor',
    }
    this.host.repo.addEvent('assignment.ended', { ticketId: ticket.id, assignmentId: assignment.id, kind })
  }

  private must(ticketId: string): Ticket {
    const ticket = this.host.repo.getDoc<Ticket>('ticket', ticketId)
    if (!ticket) throw new UserError(`unknown ticket ${ticketId}`)
    return ticket
  }
}

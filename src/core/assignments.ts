import { UserError } from '../shared/errors.ts'
import type { Ticket } from '../shared/types.ts'
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
   * Speculative tickets stay silent until deliver is true.
   */
  report(ticketId: string, report: WorkerReport): { surfaced: boolean } {
    const ticket = this.must(ticketId)
    const assignment = ticket.assignments.at(-1)
    if (!assignment) throw new UserError(`ticket ${ticketId} has no assignment`)
    assignment.report = { kind: report.kind, text: report.text, deliver: report.deliver }
    if (ticket.speculative && report.deliver !== true) {
      this.host.repo.putDoc('ticket', ticket.id, ticket)
      this.host.log(`[speculate] speculative silent ticketId=${ticket.id} deliver=false`)
      return { surfaced: false }
    }
    if (report.deliver === true) {
      const tag = ticket.speculative ? '[speculate] ' : ''
      this.host.log(`${tag}deliver=true ticketId=${ticket.id}`)
    }
    if (report.kind === 'ready' || report.kind === 'dropped' || report.kind === 'failed') {
      assignment.state = 'ended'
      assignment.endedAt = this.host.now()
      ticket.ended = {
        at: this.host.now(),
        outcome: report.kind,
        by: report.kind === 'failed' ? 'watchdog' : 'executor',
      }
      this.host.repo.addEvent('assignment.ended', { ticketId: ticket.id, assignmentId: assignment.id, kind: report.kind })
    }
    this.host.repo.putDoc('ticket', ticket.id, ticket)
    return { surfaced: report.deliver === true }
  }

  private must(ticketId: string): Ticket {
    const ticket = this.host.repo.getDoc<Ticket>('ticket', ticketId)
    if (!ticket) throw new UserError(`unknown ticket ${ticketId}`)
    return ticket
  }
}

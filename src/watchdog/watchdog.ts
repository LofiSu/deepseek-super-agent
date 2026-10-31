import type { WorkerReport } from '../core/assignments.ts'
import type { JournalEntry, SessionJournal } from '../harness/session.ts'
import type { Metrics } from '../metrics/metrics.ts'
import type { JobRow, SessionRow, Ticket } from '../shared/types.ts'
import type { Store } from '../store/sqlite.ts'

export function stuckSessions(sessions: SessionRow[], nowMs: number, stuckMs: number): SessionRow[] {
  return sessions.filter(session =>
    session.role === 'worker'
    && session.status === 'running'
    && nowMs - Date.parse(session.heartbeat) > stuckMs)
}

export interface StuckAssignment {
  ticketId: string
  assignmentId: string
  sessionId: string
  reason: 'stale' | 'failed-jobs'
}

/** A running assignment with no report, or two failed jobs, is the watchdog's signal. */
export function stuckAssignments(
  tickets: Ticket[],
  jobs: JobRow[],
  nowMs: number,
  stuckMs: number,
): StuckAssignment[] {
  const stuck: StuckAssignment[] = []
  for (const ticket of tickets) {
    if (ticket.ended) continue
    const assignment = ticket.assignments.at(-1)
    if (!assignment || assignment.state !== 'running') continue
    const sessionId = assignment.workerSessionId ?? `worker_${ticket.id}`
    const failedJobs = jobs.filter(job => job.ticketId === ticket.id && job.status === 'failed').length
    if (failedJobs >= 2) {
      stuck.push({ ticketId: ticket.id, assignmentId: assignment.id, sessionId, reason: 'failed-jobs' })
      continue
    }
    if (assignment.report) continue
    const started = Date.parse(assignment.startedAt ?? '')
    if (!Number.isFinite(started) || nowMs - started <= stuckMs) continue
    stuck.push({ ticketId: ticket.id, assignmentId: assignment.id, sessionId, reason: 'stale' })
  }
  return stuck
}

export interface WatchdogControl {
  report(ticketId: string, report: WorkerReport): { surfaced: boolean }
}

export class Watchdog {
  private readonly nudged = new Set<string>()

  constructor(private readonly opts: {
    store: Store
    engine: WatchdogControl
    journal: SessionJournal
    log: (line: string) => void
    metrics: Metrics
    intervalMs: number
    stuckMs: number
    now?: () => number
  }) {}

  get intervalMs(): number {
    return this.opts.intervalMs
  }

  tick(): void {
    if (!this.opts.store.isOpen) return
    const db = this.opts.store.health()
    const now = this.opts.now?.() ?? Date.now()
    const stuck = stuckAssignments(
      this.opts.store.listDocs<Ticket>('ticket'),
      this.opts.store.listJobs(),
      now,
      this.opts.stuckMs,
    )
    this.opts.log(`[watchdog] tick db=${db} stuck=${stuck.length}`)
    const handled = new Set<string>()
    for (const hit of stuck) {
      handled.add(hit.sessionId)
      handled.add(hit.ticketId)
      if (hit.reason === 'failed-jobs' || this.nudged.has(hit.assignmentId)) this.fail(hit)
      else this.nudge(hit)
    }
    for (const session of stuckSessions(this.opts.store.listSessions(), now, this.opts.stuckMs)) {
      if (handled.has(session.id) || (session.ticketId != null && handled.has(session.ticketId))) continue
      this.opts.journal.append(session.id, {
        role: 'user',
        kind: 'nudge',
        content: `watchdog nudge ticketId=${session.ticketId ?? ''}`,
      })
      this.opts.log(`[watchdog] nudge session=${session.id} ticketId=${session.ticketId ?? ''}`)
      this.opts.metrics.increment('watchdog.nudge')
    }
  }

  private nudge(hit: StuckAssignment): void {
    this.nudged.add(hit.assignmentId)
    const entry: JournalEntry = {
      role: 'user',
      kind: 'nudge',
      content: `watchdog nudge ticketId=${hit.ticketId}`,
    }
    this.opts.journal.append(hit.sessionId, { ...entry })
    this.opts.store.addEvent('watchdog.nudge', {
      ticketId: hit.ticketId,
      assignmentId: hit.assignmentId,
      sessionId: hit.sessionId,
    })
    this.opts.log(`[watchdog] nudge session=${hit.sessionId} ticketId=${hit.ticketId}`)
    this.opts.metrics.increment('watchdog.nudge')
  }

  private fail(hit: StuckAssignment): void {
    this.nudged.delete(hit.assignmentId)
    this.opts.engine.report(hit.ticketId, { kind: 'failed', text: 'watchdog: stuck', deliver: false })
    this.opts.store.addEvent('watchdog.fail', {
      ticketId: hit.ticketId,
      assignmentId: hit.assignmentId,
    })
    this.opts.log(`[watchdog] fail ticketId=${hit.ticketId}`)
  }
}
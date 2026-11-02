import type { WorkerReport } from '../core/assignments.ts'
import type { JournalEntry, SessionJournal } from '../harness/session.ts'
import type { Metrics } from '../metrics/metrics.ts'
import type { JobRow, SessionRow, Ticket } from '../shared/types.ts'
import type { Store } from '../store/sqlite.ts'
import { loadWatchdogRules, type WatchdogRules } from './rules.ts'

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
  reason: 'stale' | 'failed-jobs' | 'goal-drift'
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
    // A human pause is intentional idle time, not a stuck worker.
    if (ticket.collab?.paused) continue
    const assignment = ticket.assignments.at(-1)
    if (!assignment || assignment.state !== 'running') continue
    const sessionId = assignment.workerSessionId ?? `worker_${ticket.id}`
    const failedJobs = jobs.filter(job => job.ticketId === ticket.id && job.status === 'failed').length
    if (failedJobs >= 2) {
      stuck.push({ ticketId: ticket.id, assignmentId: assignment.id, sessionId, reason: 'failed-jobs' })
      continue
    }
    // A progress report is a heartbeat, not an exemption. A worker that reports
    // "still working" and then hangs must still be detected.
    const reportedAt = Date.parse(assignment.report?.at ?? '')
    const started = Date.parse(assignment.startedAt ?? '')
    const lastSeen = Number.isFinite(reportedAt) ? reportedAt : started
    if (!Number.isFinite(lastSeen) || nowMs - lastSeen <= stuckMs) continue
    stuck.push({ ticketId: ticket.id, assignmentId: assignment.id, sessionId, reason: 'stale' })
  }
  return stuck
}

/**
 * Rule-based goal drift (T43/T44): a running assignment whose latest report
 * explicitly says it left the ticket's scope. This is deliberately marker-based
 * so it cannot punish ordinary progress reports.
 */
export function driftAssignments(tickets: Ticket[], rules: WatchdogRules): StuckAssignment[] {
  const markers = rules.driftMarkers.map(marker => marker.toLowerCase())
  const hits: StuckAssignment[] = []
  for (const ticket of tickets) {
    if (ticket.ended || ticket.collab?.paused) continue
    const assignment = ticket.assignments.at(-1)
    if (!assignment || assignment.state !== 'running') continue
    const text = assignment.report?.text?.toLowerCase()
    if (!text || !markers.some(marker => text.includes(marker))) continue
    hits.push({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      sessionId: assignment.workerSessionId ?? `worker_${ticket.id}`,
      reason: 'goal-drift',
    })
  }
  return hits
}

export interface WatchdogControl {
  report(ticketId: string, report: WorkerReport): {
    surfaced: boolean
    verdict: 'deliver' | 'discard' | 'hold'
  }
}

export class Watchdog {
  private readonly nudged = new Set<string>()
  /** One drift nudge per assignment; a later report is a new signal only via `nudged`. */
  private readonly drifted = new Set<string>()
  private readonly rules: WatchdogRules

  constructor(private readonly opts: {
    store: Store
    engine: WatchdogControl
    journal: SessionJournal
    log: (line: string) => void
    metrics: Metrics
    intervalMs: number
    stuckMs: number
    /** Terminal-path callback for a speculative workdir (promote on deliver, delete on discard). */
    settle?: (sessionId: string, verdict: 'deliver' | 'discard' | 'hold') => void
    now?: () => number
  }) {
    this.rules = loadWatchdogRules()
  }

  get intervalMs(): number {
    return this.opts.intervalMs
  }

  tick(): void {
    if (!this.opts.store.isOpen) return
    const db = this.opts.store.health()
    const now = this.opts.now?.() ?? Date.now()
    const tickets = this.opts.store.listDocs<Ticket>('ticket')
    const stuck = stuckAssignments(tickets, this.opts.store.listJobs(), now, this.opts.stuckMs)
    const drift = driftAssignments(tickets, this.rules)
      .filter(hit => !stuck.some(other => other.assignmentId === hit.assignmentId))
    const hits = [...stuck, ...drift]
    this.opts.log(`[watchdog] tick db=${db} stuck=${stuck.length} drift=${drift.length}`)
    if (hits.length === 0) {
      this.opts.metrics.increment('watchdog.idle')
    }
    const handled = new Set<string>()
    for (const hit of hits) {
      handled.add(hit.sessionId)
      handled.add(hit.ticketId)
      if (hit.reason === 'goal-drift') this.nudgeDrift(hit)
      else if (hit.reason === 'failed-jobs' || this.nudged.has(hit.assignmentId)) this.fail(hit)
      else this.nudge(hit)
    }
    const pausedTickets = new Set(
      this.opts.store.listDocs<Ticket>('ticket')
        .filter(ticket => ticket.collab?.paused)
        .map(ticket => ticket.id),
    )
    for (const session of stuckSessions(this.opts.store.listSessions(), now, this.opts.stuckMs)) {
      if (handled.has(session.id) || (session.ticketId != null && handled.has(session.ticketId))) continue
      if (session.ticketId && pausedTickets.has(session.ticketId)) continue
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

  private nudgeDrift(hit: StuckAssignment): void {
    if (this.drifted.has(hit.assignmentId)) return
    this.drifted.add(hit.assignmentId)
    this.opts.journal.append(hit.sessionId, {
      role: 'user',
      kind: 'nudge',
      content: `watchdog drift ticketId=${hit.ticketId}`,
    })
    this.opts.store.addEvent('watchdog.nudge', {
      ticketId: hit.ticketId,
      assignmentId: hit.assignmentId,
      sessionId: hit.sessionId,
      reason: 'goal-drift',
    })
    this.opts.log(`[watchdog] drift nudge session=${hit.sessionId} ticketId=${hit.ticketId}`)
    this.opts.metrics.increment('watchdog.nudge')
  }

  private fail(hit: StuckAssignment): void {
    this.nudged.delete(hit.assignmentId)
    const text = hit.reason === 'failed-jobs' ? this.rules.reasons['failed-jobs'] : this.rules.reasons.stale
    const result = this.opts.engine.report(hit.ticketId, { kind: 'failed', text, deliver: false })
    // A watchdog fail is a terminal path: roll back the speculative workdir too.
    this.opts.settle?.(hit.sessionId, result.verdict)
    this.opts.store.addEvent('watchdog.fail', {
      ticketId: hit.ticketId,
      assignmentId: hit.assignmentId,
    })
    this.opts.log(`[watchdog] fail ticketId=${hit.ticketId}`)
  }
}
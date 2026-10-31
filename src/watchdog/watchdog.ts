import type { SessionRow, Ticket } from '../shared/types.ts'
import type { Store } from '../store/sqlite.ts'

export function stuckSessions(sessions: SessionRow[], nowMs: number, stuckMs: number): SessionRow[] {
  return sessions.filter(session =>
    session.role === 'worker'
    && session.status === 'running'
    && nowMs - Date.parse(session.heartbeat) > stuckMs)
}

const STOP = new Set([
  'the', 'a', 'an', 'on', 'to', 'for', 'of', 'and', 'or', 'in', 'at', 'is', 'it',
  'this', 'that', 'with', 'from', 'by',
])

export function scopeTokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length >= 3 && !STOP.has(token))
}

/** True when a running report shares no meaningful token with the mandate scope. */
export function goalDrift(scope: string, reportText: string): boolean {
  const expected = scopeTokens(scope)
  if (expected.length === 0 || reportText.trim().length === 0) return false
  const seen = new Set(scopeTokens(reportText))
  return !expected.some(token => seen.has(token))
}

export function driftingTickets(tickets: readonly Ticket[]): Ticket[] {
  return tickets.filter(ticket => {
    if (ticket.speculative || ticket.ended) return false
    const assignment = ticket.assignments.at(-1)
    if (!assignment || assignment.state !== 'running') return false
    return goalDrift(ticket.mandate.scope, assignment.report?.text ?? '')
  })
}

export interface WatchdogOptions {
  store: Store
  log: (line: string) => void
  intervalMs: number
  stuckMs: number
  /** Nudges before the next escalation fails the assignment. Default 3. */
  failAfter?: number
  /** Minimum gap between escalations for one session. Default `stuckMs`. */
  nudgeEveryMs?: number
  now?: () => number
  /** Infra probe. Defaults to `store.health()`. */
  health?: () => string
  inject?: (session: SessionRow, note: string) => void
  failAssignment?: (session: SessionRow, reason: string) => void
}

export class Watchdog {
  private readonly nudges = new Map<string, number>()
  private readonly lastNudgeAt = new Map<string, number>()
  private readonly failed = new Set<string>()

  constructor(private readonly opts: WatchdogOptions) {}

  get intervalMs(): number {
    return this.opts.intervalMs
  }

  get failAfter(): number {
    return this.opts.failAfter ?? 3
  }

  tick(): void {
    if (!this.opts.store.isOpen) return
    let db = 'ok'
    try {
      db = (this.opts.health ?? (() => this.opts.store.health()))()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.opts.log(`[watchdog] infra fault db ${message}`)
      this.opts.log('[watchdog] tick db=fault stuck=0 drift=0')
      return
    }
    const now = this.opts.now?.() ?? Date.now()
    const sessions = this.opts.store.listSessions()
    const stuck = stuckSessions(sessions, now, this.opts.stuckMs)
    const drift = driftingTickets(this.opts.store.listDocs<Ticket>('ticket'))
    this.opts.log(`[watchdog] tick db=${db} stuck=${stuck.length} drift=${drift.length}`)
    const acted = new Set<string>()
    for (const session of stuck) {
      acted.add(session.id)
      this.escalate(session, 'stuck', false, now)
    }
    for (const ticket of drift) {
      this.opts.log(`[watchdog] drift ticketId=${ticket.id}`)
      const session = sessions.find(item =>
        item.role === 'worker' && item.ticketId === ticket.id && item.status === 'running')
      if (!session || acted.has(session.id)) continue
      this.escalate(session, 'drift', false, now)
    }
    const live = new Set(sessions.filter(session => session.status === 'running').map(session => session.id))
    for (const id of [...this.nudges.keys()]) {
      if (live.has(id)) continue
      this.nudges.delete(id)
      this.lastNudgeAt.delete(id)
      this.failed.delete(id)
    }
  }

  nudgeTicket(ticketId: string): void {
    this.escalate(this.findWorker(ticketId), 'tool', true, this.opts.now?.() ?? Date.now())
  }

  failTicket(ticketId: string, reason: string): void {
    this.commitFail(this.findWorker(ticketId), reason)
  }

  private findWorker(ticketId: string): SessionRow {
    const found = this.opts.store.listSessions().find(session =>
      session.role === 'worker' && session.ticketId === ticketId)
    if (found) return found
    const at = new Date(0).toISOString()
    return {
      id: `worker_${ticketId}`,
      role: 'worker',
      ticketId,
      status: 'running',
      heartbeat: at,
      createdAt: at,
    }
  }

  private escalate(session: SessionRow, reason: string, force: boolean, now: number): void {
    if (this.failed.has(session.id)) return
    const count = this.nudges.get(session.id) ?? 0
    const previous = this.lastNudgeAt.get(session.id) ?? 0
    const gap = this.opts.nudgeEveryMs ?? this.opts.stuckMs
    if (!force && count > 0 && now - previous < gap) return
    const next = count + 1
    this.nudges.set(session.id, next)
    this.lastNudgeAt.set(session.id, now)
    if (next > this.failAfter) {
      this.commitFail(session, `${reason} after ${this.failAfter} nudges`)
      return
    }
    const ticketId = session.ticketId ?? ''
    this.opts.log(`[watchdog] nudge session=${session.id} ticketId=${ticketId} n=${next} reason=${reason}`)
    this.opts.store.addEvent('watchdog.nudge', { sessionId: session.id, ticketId, n: next, reason })
    this.opts.inject?.(session, `nudge n=${next} reason=${reason}`)
  }

  private commitFail(session: SessionRow, reason: string): void {
    if (this.failed.has(session.id)) return
    this.failed.add(session.id)
    const ticketId = session.ticketId ?? ''
    this.opts.log(`[watchdog] fail session=${session.id} ticketId=${ticketId} reason=${reason}`)
    try {
      this.opts.store.addEvent('watchdog.fail', { sessionId: session.id, ticketId, reason })
      this.opts.failAssignment?.(session, reason)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.opts.log(`[watchdog] fail error session=${session.id} ${message}`)
    }
  }
}

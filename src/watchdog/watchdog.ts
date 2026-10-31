import type { SessionRow } from '../shared/types.ts'
import type { Store } from '../store/sqlite.ts'

export function stuckSessions(sessions: SessionRow[], nowMs: number, stuckMs: number): SessionRow[] {
  return sessions.filter(session =>
    session.role === 'worker'
    && session.status === 'running'
    && nowMs - Date.parse(session.heartbeat) > stuckMs)
}

export class Watchdog {
  constructor(private readonly opts: {
    store: Store
    log: (line: string) => void
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
    const stuck = stuckSessions(this.opts.store.listSessions(), now, this.opts.stuckMs)
    this.opts.log(`[watchdog] tick db=${db} stuck=${stuck.length}`)
    for (const session of stuck) {
      this.opts.log(`[watchdog] nudge session=${session.id} ticketId=${session.ticketId ?? ''}`)
    }
  }
}

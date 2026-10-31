import fs from 'node:fs'
import path from 'node:path'
import type { Store } from '../store/sqlite.ts'

export function workerSessionId(ticketId: string): string {
  return `worker_${ticketId}`
}

/** Append-only JSONL plus a SQLite copy so a restart can still read the session. */
export class SessionJournal {
  private announced = false

  constructor(
    private readonly dir: string,
    private readonly store: Store,
    private readonly log: (line: string) => void,
  ) {
    fs.mkdirSync(dir, { recursive: true })
  }

  append(sessionId: string, event: Record<string, unknown>): void {
    if (!this.announced) {
      this.announced = true
      this.log(`[harness] session journal jsonl dir=${this.dir}`)
    }
    const line = JSON.stringify({ t: new Date().toISOString(), sessionId, ...event })
    fs.appendFileSync(path.join(this.dir, `${sessionId}.jsonl`), `${line}\n`)
    // Turns outlive finish()/close(). node:sqlite throws ERR_INVALID_STATE if we write after that.
    if (!this.store.isOpen) return
    this.store.appendMessage(sessionId, String(event.role ?? event.kind ?? 'event'), line)
    const existing = this.store.listSessions().find(session => session.id === sessionId)
    if (existing) {
      this.store.upsertSession({ ...existing, heartbeat: new Date().toISOString() })
    }
  }
}

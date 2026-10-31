import fs from 'node:fs'
import path from 'node:path'
import type { ToolCall } from './model.ts'
import type { Store } from '../store/sqlite.ts'

export interface JournalEntry {
  role?: string
  kind?: string
  content?: string
  name?: string
  toolCallId?: string
  toolCalls?: ToolCall[]
}

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

  /** Prior turns for this session. The next model call is built from these entries. */
  history(sessionId: string): JournalEntry[] {
    const lines = this.lines(sessionId)
    const entries: JournalEntry[] = []
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as JournalEntry
        if (parsed && typeof parsed === 'object') entries.push(parsed)
      } catch {
        // A torn line is not a turn.
      }
    }
    return entries
  }

  private lines(sessionId: string): string[] {
    if (this.store.isOpen) return this.store.listMessages(sessionId).map(row => row.body)
    const file = path.join(this.dir, `${sessionId}.jsonl`)
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf8').split('\n').filter(line => line.length > 0)
  }
}
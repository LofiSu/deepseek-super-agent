import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DomainEventName } from '../shared/events.ts'
import type { JobRow, ReplyRow, SessionRow } from '../shared/types.ts'
import { SCHEMA } from './schema.ts'

export class Store {
  readonly path: string
  private readonly db: DatabaseSync
  private depth = 0
  private closed = false

  constructor(home: string) {
    fs.mkdirSync(home, { recursive: true })
    this.path = path.join(home, 'ds-agent.db')
    this.db = new DatabaseSync(this.path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  get isOpen(): boolean {
    return !this.closed
  }

  close(): void {
    if (this.closed) return
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    this.db.close()
    this.closed = true
  }

  health(): string {
    const row = this.db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined
    if (row?.ok !== 1) throw new Error('sqlite health check failed')
    return 'ok'
  }

  atomic<T>(work: () => T): T {
    if (this.depth > 0) return work()
    this.depth += 1
    try {
      this.db.exec('BEGIN')
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // The transaction may already be closed.
      }
      throw error
    } finally {
      this.depth -= 1
    }
  }

  nextId(prefix: string): string {
    const row = this.db.prepare(
      `INSERT INTO id_seq(prefix, n) VALUES(?, 1)
       ON CONFLICT(prefix) DO UPDATE SET n = n + 1
       RETURNING n`,
    ).get(prefix) as { n: number }
    return `${prefix}_${row.n}`
  }

  putDoc(kind: string, id: string, value: unknown): void {
    this.db.prepare(
      `INSERT INTO documents(kind, id, payload) VALUES(?, ?, ?)
       ON CONFLICT(kind, id) DO UPDATE SET payload = excluded.payload`,
    ).run(kind, id, JSON.stringify(value))
  }

  getDoc<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare(
      'SELECT payload FROM documents WHERE kind = ? AND id = ?',
    ).get(kind, id) as { payload: string } | undefined
    return row ? JSON.parse(row.payload) as T : undefined
  }

  listDocs<T>(kind: string): T[] {
    const rows = this.db.prepare(
      'SELECT payload FROM documents WHERE kind = ? ORDER BY rowid',
    ).all(kind) as { payload: string }[]
    return rows.map(row => JSON.parse(row.payload) as T)
  }

  addEvent(type: DomainEventName, payload: unknown): void {
    this.db.prepare(
      'INSERT INTO events(type, payload, created_at) VALUES(?, ?, ?)',
    ).run(type, JSON.stringify(payload), new Date().toISOString())
  }

  listEvents(): { type: DomainEventName; payload: unknown; createdAt: string }[] {
    const rows = this.db.prepare(
      'SELECT type, payload, created_at FROM events ORDER BY id',
    ).all() as { type: DomainEventName; payload: string; created_at: string }[]
    return rows.map(row => ({
      type: row.type,
      payload: JSON.parse(row.payload) as unknown,
      createdAt: row.created_at,
    }))
  }

  addReply(row: ReplyRow): void {
    this.db.prepare(
      `INSERT INTO replies(id, ticket_id, channel, purpose, text, status, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.ticketId, row.channel, row.purpose, row.text, row.status, row.createdAt)
  }

  markReplySent(id: string): void {
    this.db.prepare(`UPDATE replies SET status = 'sent' WHERE id = ?`).run(id)
  }

    listReplies(): ReplyRow[] {
    const rows = this.db.prepare(
      'SELECT id, ticket_id, channel, purpose, text, status, created_at FROM replies ORDER BY rowid',
    ).all() as Record<string, string>[]
    return rows.map(row => ({
      id: row.id,
      ticketId: row.ticket_id,
      channel: row.channel,
      purpose: row.purpose,
      text: row.text,
      status: row.status as ReplyRow['status'],
      createdAt: row.created_at,
    }))
  }

  addSubscription(threadKey: string, ticketId: string, at: string): void {
    this.db.prepare(
      `INSERT INTO subscriptions(thread_key, ticket_id, created_at) VALUES(?, ?, ?)
       ON CONFLICT(thread_key, ticket_id) DO NOTHING`,
    ).run(threadKey, ticketId, at)
  }

  listSubscriptions(): { threadKey: string; ticketId: string }[] {
    const rows = this.db.prepare(
      'SELECT thread_key, ticket_id FROM subscriptions ORDER BY rowid',
    ).all() as { thread_key: string; ticket_id: string }[]
    return rows.map(row => ({ threadKey: row.thread_key, ticketId: row.ticket_id }))
  }

  putSpill(body: string): string {
    const id = this.nextId('spill')
    this.db.prepare('INSERT INTO spills(id, body, created_at) VALUES(?, ?, ?)').run(id, body, new Date().toISOString())
    return id
  }

  getSpill(id: string): string | undefined {
    const row = this.db.prepare('SELECT body FROM spills WHERE id = ?').get(id) as { body: string } | undefined
    return row?.body
  }

  grantSpill(spillId: string, grantee: string): void {
    this.db.prepare(
      'INSERT INTO spill_grants(spill_id, grantee) VALUES(?, ?) ON CONFLICT(spill_id, grantee) DO NOTHING',
    ).run(spillId, grantee)
  }

  spillGrants(spillId: string): string[] {
    const rows = this.db.prepare(
      'SELECT grantee FROM spill_grants WHERE spill_id = ? ORDER BY grantee',
    ).all(spillId) as { grantee: string }[]
    return rows.map(row => row.grantee)
  }

  createJob(input: { sessionId: string; ticketId: string; name: string }): JobRow {
    const row: JobRow = {
      id: this.nextId('job'),
      sessionId: input.sessionId,
      ticketId: input.ticketId,
      name: input.name,
      status: 'running',
      createdAt: new Date().toISOString(),
    }
    this.db.prepare(
      `INSERT INTO jobs(id, session_id, ticket_id, name, status, created_at, finished_at)
       VALUES(?, ?, ?, ?, ?, ?, NULL)`,
    ).run(row.id, row.sessionId, row.ticketId, row.name, row.status, row.createdAt)
    return row
  }

  completeJob(id: string, status: JobRow['status'] = 'succeeded'): void {
    this.db.prepare(
      'UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?',
    ).run(status, new Date().toISOString(), id)
  }

  getJob(id: string): JobRow | undefined {
    return this.listJobs().find(job => job.id === id)
  }

  listJobs(): JobRow[] {
    const rows = this.db.prepare(
      'SELECT id, session_id, ticket_id, name, status, created_at, finished_at FROM jobs ORDER BY rowid',
    ).all() as Record<string, string | null>[]
    return rows.map(row => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      ticketId: String(row.ticket_id),
      name: String(row.name),
      status: row.status as JobRow['status'],
      createdAt: String(row.created_at),
      finishedAt: row.finished_at ? String(row.finished_at) : undefined,
    }))
  }

  upsertSession(row: SessionRow): void {
    this.db.prepare(
      `INSERT INTO sessions(id, role, ticket_id, status, heartbeat, created_at)
       VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         role = excluded.role,
         ticket_id = excluded.ticket_id,
         status = excluded.status,
         heartbeat = excluded.heartbeat`,
    ).run(row.id, row.role, row.ticketId ?? null, row.status, row.heartbeat, row.createdAt)
  }

  listSessions(): SessionRow[] {
    const rows = this.db.prepare(
      'SELECT id, role, ticket_id, status, heartbeat, created_at FROM sessions ORDER BY rowid',
    ).all() as Record<string, string | null>[]
    return rows.map(row => ({
      id: String(row.id),
      role: row.role as SessionRow['role'],
      ticketId: row.ticket_id ? String(row.ticket_id) : undefined,
      status: row.status as SessionRow['status'],
      heartbeat: String(row.heartbeat),
      createdAt: String(row.created_at),
    }))
  }

  appendMessage(sessionId: string, role: string, body: string): void {
    this.db.prepare(
      'INSERT INTO messages(session_id, role, body, created_at) VALUES(?, ?, ?, ?)',
    ).run(sessionId, role, body, new Date().toISOString())
  }

  listMessages(sessionId?: string): { sessionId: string; role: string; body: string }[] {
    const rows = (sessionId
      ? this.db.prepare(
        'SELECT session_id, role, body FROM messages WHERE session_id = ? ORDER BY id',
      ).all(sessionId)
      : this.db.prepare(
        'SELECT session_id, role, body FROM messages ORDER BY id',
      ).all()) as { session_id: string; role: string; body: string }[]
    return rows.map(row => ({ sessionId: row.session_id, role: row.role, body: row.body }))
  }

  addArtifact(ticketId: string, filePath: string): string {
    const id = this.nextId('art')
    this.db.prepare(
      'INSERT INTO artifacts(id, ticket_id, path, created_at) VALUES(?, ?, ?, ?)',
    ).run(id, ticketId, filePath, new Date().toISOString())
    return id
  }
}
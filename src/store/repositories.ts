import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type {
  Assignment,
  Channel,
  Decision,
  Eval,
  Job,
  Mandate,
  Source,
  Subscription,
  Ticket,
  Trigger,
  Thread,
} from '../shared/types.js'
import type { JobQueue, Repositories } from '../shared/ports.js'
import { SCHEMA } from './schema.js'
import { SqliteSpill } from './spill.js'

interface BodyRow {
  body: string
}

export class SqliteStore implements Repositories, JobQueue {
  readonly db: Database.Database
  readonly spill: SqliteSpill

  readonly sources = {
    get: (id: string): Source | undefined => this.read('SELECT body FROM sources WHERE id = ?', id),
    save: (source: Source): void => {
      this.db.prepare(
        `INSERT INTO sources (id, kind, enabled, cursor, body) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, enabled = excluded.enabled, cursor = excluded.cursor, body = excluded.body`,
      ).run(source.id, source.kind, source.enabled ? 1 : 0, source.cursor ?? null, JSON.stringify(source))
    },
    list: (): Source[] => this.list('SELECT body FROM sources ORDER BY id'),
  }

  readonly triggers = {
    get: (id: string): Trigger | undefined => this.read('SELECT body FROM triggers WHERE id = ?', id),
    save: (trigger: Trigger): void => {
      this.db.prepare(
        `INSERT INTO triggers (id, source, at, body) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET source = excluded.source, at = excluded.at, body = excluded.body`,
      ).run(trigger.id, trigger.source, trigger.at, JSON.stringify(trigger))
    },
    list: (): Trigger[] => this.list('SELECT body FROM triggers ORDER BY at, id'),
  }

  readonly threads = {
    get: (key: string): Thread | undefined => this.read('SELECT body FROM threads WHERE key = ?', key),
    save: (thread: Thread): void => {
      this.db.prepare(
        `INSERT INTO threads (key, source, body) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET source = excluded.source, body = excluded.body`,
      ).run(thread.key, thread.ref.source, JSON.stringify(thread))
    },
    list: (): Thread[] => this.list('SELECT body FROM threads ORDER BY key'),
  }

  readonly evals = {
    get: (id: string): Eval | undefined => this.read('SELECT body FROM evals WHERE id = ?', id),
    save: (evaluation: Eval): void => {
      this.db.prepare(
        `INSERT INTO evals (id, thread_key, body) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET thread_key = excluded.thread_key, body = excluded.body`,
      ).run(evaluation.id, evaluation.threadKey, JSON.stringify(evaluation))
    },
    byThread: (threadKey: string): Eval[] => this.list('SELECT body FROM evals WHERE thread_key = ? ORDER BY id', threadKey),
  }

  readonly mandates = {
    get: (ticketId: string): Mandate | undefined => this.read('SELECT body FROM mandates WHERE ticket_id = ?', ticketId),
    save: (ticketId: string, mandate: Mandate): void => {
      this.db.prepare(
        `INSERT INTO mandates (ticket_id, body) VALUES (?, ?)
         ON CONFLICT(ticket_id) DO UPDATE SET body = excluded.body`,
      ).run(ticketId, JSON.stringify(mandate))
    },
  }

  readonly tickets = {
    get: (id: string): Ticket | undefined => this.read('SELECT body FROM tickets WHERE id = ?', id),
    save: (ticket: Ticket): void => {
      this.db.prepare(
        `INSERT INTO tickets (id, status, body) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, body = excluded.body`,
      ).run(ticket.id, ticket.status, JSON.stringify(ticket))
      this.mandates.save(ticket.id, ticket.mandate)
    },
    list: (): Ticket[] => this.list('SELECT body FROM tickets ORDER BY id'),
    open: (): Ticket[] => this.list("SELECT body FROM tickets WHERE status = 'open' ORDER BY id"),
  }

  readonly assignments = {
    get: (id: string): Assignment | undefined => this.read('SELECT body FROM assignments WHERE id = ?', id),
    save: (assignment: Assignment): void => {
      this.db.prepare(
        `INSERT INTO assignments (id, ticket_id, state, body) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET ticket_id = excluded.ticket_id, state = excluded.state, body = excluded.body`,
      ).run(assignment.id, assignment.ticketId, assignment.state, JSON.stringify(assignment))
    },
    byTicket: (ticketId: string): Assignment[] => this.list('SELECT body FROM assignments WHERE ticket_id = ? ORDER BY id', ticketId),
  }

  readonly subscriptions = {
    save: (subscription: Subscription): void => {
      this.db.prepare(
        `INSERT INTO subscriptions (thread_key, ticket_id, body) VALUES (?, ?, ?)
         ON CONFLICT(thread_key, ticket_id) DO UPDATE SET body = excluded.body`,
      ).run(subscription.threadKey, subscription.ticketId, JSON.stringify(subscription))
    },
    remove: (threadKey: string, ticketId: string): void => {
      this.db.prepare('DELETE FROM subscriptions WHERE thread_key = ? AND ticket_id = ?').run(threadKey, ticketId)
    },
    byThread: (threadKey: string): Subscription[] => this.list('SELECT body FROM subscriptions WHERE thread_key = ? ORDER BY ticket_id', threadKey),
    byTicket: (ticketId: string): Subscription[] => this.list('SELECT body FROM subscriptions WHERE ticket_id = ? ORDER BY thread_key', ticketId),
  }

  readonly channels = {
    save: (channel: Channel): void => {
      const id = channelKey(channel)
      this.db.prepare(
        `INSERT INTO channels (id, ticket_id, body) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET ticket_id = excluded.ticket_id, body = excluded.body`,
      ).run(id, channel.ticketId ?? null, JSON.stringify(channel))
    },
    list: (): Channel[] => this.list('SELECT body FROM channels ORDER BY id'),
    byTicket: (ticketId: string): Channel[] => this.list('SELECT body FROM channels WHERE ticket_id = ? ORDER BY id', ticketId),
  }

  readonly decisions = {
    get: (id: string): Decision | undefined => this.read('SELECT body FROM decisions WHERE id = ?', id),
    save: (decision: Decision): void => {
      this.db.prepare(
        `INSERT INTO decisions (id, thread_key, kind, body) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET thread_key = excluded.thread_key, kind = excluded.kind, body = excluded.body`,
      ).run(decision.id, decision.threadKey, decision.kind, JSON.stringify(decision))
    },
    byThread: (threadKey: string): Decision[] => this.list('SELECT body FROM decisions WHERE thread_key = ? ORDER BY id', threadKey),
  }

  readonly jobs = {
    get: (id: string): Job | undefined => this.read('SELECT body FROM jobs WHERE id = ?', id),
    save: (job: Job): void => {
      this.db.prepare(
        `INSERT INTO jobs (id, session_id, status, body) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, status = excluded.status, body = excluded.body`,
      ).run(job.id, job.sessionId, job.status, JSON.stringify(job))
    },
    bySession: (sessionId: string): Job[] => this.list('SELECT body FROM jobs WHERE session_id = ? ORDER BY id', sessionId),
  }

  constructor(filename = ':memory:', now?: () => string) {
    this.db = new Database(filename)
    this.db.pragma('foreign_keys = ON')
    this.db.exec(SCHEMA)
    this.spill = new SqliteSpill(this.db, now)
  }

  atomic<T>(work: () => T): T {
    return this.db.transaction(work)()
  }

  start(sessionId: string): Job {
    const job: Job = { id: randomUUID(), sessionId, status: 'started' }
    this.jobs.save(job)
    return job
  }

  close(): void {
    this.db.close()
  }

  private read<T>(sql: string, id: string): T | undefined {
    const row = this.db.prepare(sql).get(id) as BodyRow | undefined
    return row ? JSON.parse(row.body) as T : undefined
  }

  private list<T>(sql: string, param?: string): T[] {
    const rows = (param === undefined
      ? this.db.prepare(sql).all()
      : this.db.prepare(sql).all(param)) as BodyRow[]
    return rows.map(row => JSON.parse(row.body) as T)
  }
}

export function openStore(filename = ':memory:', now?: () => string): SqliteStore {
  return new SqliteStore(filename, now)
}

function channelKey(channel: Channel): string {
  return `${channel.ref.source}:${channel.ref.thread}:${JSON.stringify(channel.ref.address)}:${channel.ticketId ?? ''}`
}

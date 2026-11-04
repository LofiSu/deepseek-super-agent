import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../shared/errors.ts'

/** SQLite document store plus the side tables the demo must reopen after restart. */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS id_seq (
  prefix TEXT PRIMARY KEY,
  n INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS spills (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spill_grants (
  spill_id TEXT NOT NULL,
  grantee TEXT NOT NULL,
  PRIMARY KEY (spill_id, grantee)
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  ticket_id TEXT,
  status TEXT NOT NULL,
  heartbeat TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS replies (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  purpose TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  reply_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  thread TEXT NOT NULL,
  target TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  external_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE TABLE IF NOT EXISTS subscriptions (
  thread_key TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (thread_key, ticket_id)
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`

/** The schema version this build writes and understands. */
export const LATEST_SCHEMA_VERSION = 2

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`

export interface StoreMigration {
  readonly version: number
  up(db: DatabaseSync): void
}

function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (rows.some(row => row.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
}

/**
 * Ordered schema migrations. Version 1 is the original `SCHEMA`; version 2
 * adds the outbox columns that earlier builds created with `ensureColumn`.
 * Add new steps here and bump `LATEST_SCHEMA_VERSION`; never edit an applied
 * step in place.
 */
export const MIGRATIONS: readonly StoreMigration[] = [
  {
    version: 1,
    up: db => db.exec(SCHEMA),
  },
  {
    version: 2,
    up: db => {
      ensureColumn(db, 'outbox', 'idempotency_key', 'TEXT')
      ensureColumn(db, 'outbox', 'attempts', 'INTEGER NOT NULL DEFAULT 0')
      ensureColumn(db, 'outbox', 'next_attempt_at', 'TEXT')
    },
  },
]

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(name) as { name: string } | undefined
  return row !== undefined
}

/**
 * Bring `db` to `latest` inside one serialized transaction.
 *
 * - A fresh database runs every migration starting at version 1.
 * - A legacy or partially-created database (no `schema_migrations` ledger)
 *   runs every migration too; `SCHEMA` uses `CREATE TABLE IF NOT EXISTS`, so
 *   existing tables and rows are left alone while missing tables are filled in.
 * - A database recorded above `latest` fails closed before any write.
 *
 * Migration list versions must be unique. Openers serialize on
 * `BEGIN IMMEDIATE` and re-read the ledger inside the transaction, so two
 * processes opening the same fresh database cannot both apply version 1.
 * On any migration failure the whole transaction rolls back, so the database
 * stays at its previous version.
 */
export function migrate(
  db: DatabaseSync,
  migrations: readonly StoreMigration[] = MIGRATIONS,
  latest: number = LATEST_SCHEMA_VERSION,
): number {
  const ordered = [...migrations].sort((left, right) => left.version - right.version)
  for (let index = 0; index < ordered.length; index += 1) {
    const migration = ordered[index]
    if (migration.version < 1) {
      throw new UserError(`invalid schema migration version ${migration.version}`)
    }
    if (migration.version > latest) {
      throw new UserError(
        `schema migration version ${migration.version} is newer than supported version ${latest}`,
      )
    }
    const previous = ordered[index - 1]
    if (previous && previous.version === migration.version) {
      throw new UserError(`duplicate schema migration version ${migration.version}`)
    }
  }

  // Wait for a concurrent opener before any read or write, then fail closed
  // before taking a write lock so a newer database is untouched.
  db.exec('PRAGMA busy_timeout = 5000')
  if (tableExists(db, 'schema_migrations')) {
    const row = db.prepare(
      'SELECT MAX(version) AS version FROM schema_migrations',
    ).get() as { version: number | null }
    const known = row.version == null ? 0 : Number(row.version)
    if (known > latest) throw newerVersionError(known, latest)
    if (known >= latest) return known
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    // Re-read inside the write transaction: another opener may have applied
    // migrations while this connection waited for the lock.
    db.exec(SCHEMA_MIGRATIONS_DDL)
    const row = db.prepare(
      'SELECT MAX(version) AS version FROM schema_migrations',
    ).get() as { version: number | null }
    const current = row.version == null ? 0 : Number(row.version)
    if (current > latest) throw newerVersionError(current, latest)

    const pending = ordered.filter(migration => migration.version > current)
    if (pending.length === 0) {
      db.exec('COMMIT')
      return current
    }

    const record = db.prepare(
      'INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)',
    )
    let applied = current
    for (const migration of pending) {
      migration.up(db)
      record.run(migration.version, new Date().toISOString())
      applied = migration.version
    }
    db.exec('COMMIT')
    return applied
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The transaction may already be closed.
    }
    throw error
  }
}

function newerVersionError(current: number, latest: number): UserError {
  return new UserError(
    `database schema version ${current} is newer than this build supports (${latest}); ` +
    'upgrade ds-agent before opening this store',
  )
}

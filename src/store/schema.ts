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

function userTableCount(db: DatabaseSync): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS count FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  ).get() as { count: number }
  return Number(row.count)
}

/**
 * Bring `db` to `latest` inside one transaction.
 *
 * - A fresh database runs every migration starting at version 1.
 * - A legacy database (tables but no `schema_migrations`) is baselined at
 *   version 1 without re-running creation, then later migrations are applied.
 * - A database recorded above `latest` fails closed before any write.
 *
 * Migration list versions must be unique. On any migration failure the whole
 * transaction rolls back, so the database stays at its previous version.
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

  const hasMigrationTable = tableExists(db, 'schema_migrations')
  let current = 0
  if (hasMigrationTable) {
    const row = db.prepare(
      'SELECT MAX(version) AS version FROM schema_migrations',
    ).get() as { version: number | null }
    current = row.version == null ? 0 : Number(row.version)
    if (current > latest) {
      throw new UserError(
        `database schema version ${current} is newer than this build supports (${latest}); ` +
        'upgrade ds-agent before opening this store',
      )
    }
  }

  const legacy = !hasMigrationTable && userTableCount(db) > 0
  const pending = ordered.filter(migration => migration.version > current)
  if (pending.length === 0) return current

  db.exec('BEGIN')
  try {
    db.exec(SCHEMA_MIGRATIONS_DDL)
    const record = db.prepare(
      'INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)',
    )
    let applied = current
    for (const migration of pending) {
      // A legacy tree already has version 1's tables; record the baseline but
      // do not recreate or rewrite them.
      if (!(legacy && migration.version === 1)) migration.up(db)
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

import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { UserError } from '../src/shared/errors.ts'
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  migrate,
  type StoreMigration,
} from '../src/store/schema.ts'
import { Store } from '../src/store/sqlite.ts'

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-store-migration-'))
  homes.push(home)
  return home
}

function dbPath(home: string): string {
  return path.join(home, 'ds-agent.db')
}

function inspect<T>(home: string, work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath(home))
  try {
    return work(db)
  } finally {
    db.close()
  }
}

function migrationRows(home: string): { version: number; applied_at: string }[] {
  return inspect(home, db =>
    db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version')
      .all() as { version: number; applied_at: string }[],
  )
}

function tableNames(home: string): string[] {
  return inspect(home, db =>
    (db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all() as { name: string }[]).map(row => row.name),
  )
}

function rawDocument(home: string, kind: string, id: string): string | undefined {
  return inspect(home, db =>
    (db.prepare('SELECT payload FROM documents WHERE kind = ? AND id = ?')
      .get(kind, id) as { payload: string } | undefined)?.payload,
  )
}

function rawSpill(home: string, id: string): string | undefined {
  return inspect(home, db =>
    (db.prepare('SELECT body FROM spills WHERE id = ?')
      .get(id) as { body: string } | undefined)?.body,
  )
}

function outboxColumns(home: string): string[] {
  return inspect(home, db =>
    (db.prepare('PRAGMA table_info(outbox)').all() as { name: string }[]).map(row => row.name),
  )
}

function captureError(work: () => unknown): Error {
  try {
    work()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the operation to throw')
}

/**
 * Version 1 tables as they existed before migrations, with an outbox that
 * predates `idempotency_key`, `attempts`, and `next_attempt_at`.
 */
const LEGACY_SCHEMA = `
CREATE TABLE documents (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE TABLE spills (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  ticket_id TEXT,
  status TEXT NOT NULL,
  heartbeat TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE replies (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  purpose TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  reply_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  thread TEXT NOT NULL,
  target TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  external_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
`

const LEGACY_OUTBOX_SCHEMA = `
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  reply_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  thread TEXT NOT NULL,
  target TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  external_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
`

describe('store schema migrations', () => {
  it('migrates a fresh database and reopening is a no-op', () => {
    const home = tempHome()
    const store = new Store(home)
    expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    store.close()

    const firstRows = migrationRows(home)
    expect(firstRows.map(row => row.version)).toEqual(
      Array.from({ length: LATEST_SCHEMA_VERSION }, (_, index) => index + 1),
    )
    expect(new Set(firstRows.map(row => row.version)).size).toBe(LATEST_SCHEMA_VERSION)
    expect(firstRows.every(row => typeof row.applied_at === 'string' && row.applied_at.length > 0)).toBe(true)

    const reopened = new Store(home)
    expect(reopened.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    reopened.close()

    expect(migrationRows(home)).toEqual(firstRows)
    expect(tableNames(home)).toContain('schema_migrations')
  })

  it('baselines a legacy database without rewriting its tables or data', () => {
    const home = tempHome()
    const db = new DatabaseSync(dbPath(home))
    db.exec(LEGACY_SCHEMA)
    db.prepare('INSERT INTO documents(kind, id, payload) VALUES(?, ?, ?)')
      .run('note', 'doc_1', JSON.stringify({ body: 'keep me', nested: { n: 7 } }))
    db.prepare('INSERT INTO spills(id, body, created_at) VALUES(?, ?, ?)')
      .run('spill_1', 'legacy spill body', '2026-01-01T00:00:00.000Z')
    db.close()

    const legacyTables = tableNames(home)

    const store = new Store(home)
    expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    expect(store.getDoc('note', 'doc_1')).toEqual({ body: 'keep me', nested: { n: 7 } })
    expect(store.getSpill('spill_1')).toBe('legacy spill body')
    store.close()

    expect(migrationRows(home).map(row => row.version)).toEqual([1, LATEST_SCHEMA_VERSION])
    const columns = outboxColumns(home)
    for (const column of ['idempotency_key', 'attempts', 'next_attempt_at']) {
      expect(columns).toContain(column)
    }
    // The legacy tree is only baselined: version 1's creation is not re-run.
    expect(tableNames(home).sort()).toEqual([...legacyTables, 'schema_migrations'].sort())
    expect(rawDocument(home, 'note', 'doc_1')).toBe(JSON.stringify({ body: 'keep me', nested: { n: 7 } }))
    expect(rawSpill(home, 'spill_1')).toBe('legacy spill body')
  })

  it('fails closed without writing when the database is newer than this build', () => {
    const home = tempHome()
    const futureVersion = LATEST_SCHEMA_VERSION + 1
    const db = new DatabaseSync(dbPath(home))
    db.exec(`
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE documents (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
`)
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)')
      .run(futureVersion, '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO documents(kind, id, payload) VALUES(?, ?, ?)')
      .run('note', 'doc_1', JSON.stringify({ body: 'future data' }))
    db.close()

    const tablesBefore = tableNames(home)
    const rowsBefore = migrationRows(home)
    const documentBefore = rawDocument(home, 'note', 'doc_1')

    const error = captureError(() => new Store(home))
    expect(error).toBeInstanceOf(UserError)
    expect(error.message).toContain(`database schema version ${futureVersion}`)
    expect(error.message).toContain(`(${LATEST_SCHEMA_VERSION})`)
    expect(error.message).toContain('newer than this build supports')

    expect(tableNames(home)).toEqual(tablesBefore)
    expect(migrationRows(home)).toEqual(rowsBefore)
    expect(rawDocument(home, 'note', 'doc_1')).toBe(documentBefore)
    expect(tablesBefore).not.toContain('outbox')
  })

  it('rolls back a failing migration and leaves the store usable', () => {
    const home = tempHome()
    const store = new Store(home)
    expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    store.putDoc('note', 'doc_1', { body: 'keep me' })
    store.replaceSpill('spill_1', 'keep this spill')
    store.close()

    const rowsBefore = migrationRows(home)
    const documentBefore = rawDocument(home, 'note', 'doc_1')
    const spillBefore = rawSpill(home, 'spill_1')

    const failing: StoreMigration = {
      version: LATEST_SCHEMA_VERSION + 1,
      up: db => {
        db.exec('CREATE TABLE migration_side_effect (id INTEGER PRIMARY KEY)')
        db.prepare('INSERT INTO migration_side_effect(id) VALUES(1)').run()
        throw new Error('injected migration failure')
      },
    }
    const db = new DatabaseSync(dbPath(home))
    try {
      const error = captureError(() => migrate(db, [failing], LATEST_SCHEMA_VERSION + 1))
      expect(error.message).toBe('injected migration failure')
    } finally {
      db.close()
    }

    expect(migrationRows(home)).toEqual(rowsBefore)
    expect(tableNames(home)).not.toContain('migration_side_effect')
    expect(rawDocument(home, 'note', 'doc_1')).toBe(documentBefore)
    expect(rawSpill(home, 'spill_1')).toBe(spillBefore)

    const reopened = new Store(home)
    expect(reopened.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    expect(reopened.getDoc('note', 'doc_1')).toEqual({ body: 'keep me' })
    expect(reopened.getSpill('spill_1')).toBe('keep this spill')
    reopened.close()
    expect(migrationRows(home)).toEqual(rowsBefore)
  })

  it('rejects duplicate migration versions deterministically before writing', () => {
    const home = tempHome()
    const db = new DatabaseSync(dbPath(home))
    try {
      const noop: StoreMigration = { version: 1, up: () => undefined }
      const error = captureError(() => migrate(db, [noop, { version: 1, up: () => undefined }], 1))
      expect(error).toBeInstanceOf(UserError)
      expect(error.message).toBe('duplicate schema migration version 1')
    } finally {
      db.close()
    }
    expect(tableNames(home)).toEqual([])
  })

  it('applies the version 2 outbox migration idempotently', () => {
    const home = tempHome()
    const db = new DatabaseSync(dbPath(home))
    try {
      db.exec(LEGACY_OUTBOX_SCHEMA)
      const outboxMigration = MIGRATIONS.find(migration => migration.version === 2)
      expect(outboxMigration).toBeDefined()
      outboxMigration!.up(db)
      outboxMigration!.up(db)
      const columns = (db.prepare('PRAGMA table_info(outbox)').all() as { name: string }[])
        .map(row => row.name)
      for (const column of ['idempotency_key', 'attempts', 'next_attempt_at']) {
        expect(columns.filter(name => name === column)).toHaveLength(1)
      }
    } finally {
      db.close()
    }
  })
})

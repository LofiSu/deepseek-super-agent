import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { UserError } from '../src/shared/errors.ts'
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  migrate,
  type StoreMigration,
} from '../src/store/schema.ts'
import { Store } from '../src/store/sqlite.ts'

const homes: string[] = []
const execFileAsync = promisify(execFile)

/**
 * Child-process opener for the interleaving test. Both processes wait for the
 * same wall-clock start so their `migrate()` calls overlap on one fresh file.
 */
const OPENER_SCRIPT = `
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const [schemaPath, dbFile, startAtRaw] = process.argv.slice(2)
const waitMs = Number(startAtRaw) - Date.now()
if (waitMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs)
const { migrate, MIGRATIONS, LATEST_SCHEMA_VERSION } = await import(pathToFileURL(schemaPath).href)
const db = new DatabaseSync(dbFile)
const version = migrate(db, MIGRATIONS, LATEST_SCHEMA_VERSION)
db.close()
process.stdout.write(String(version))
`

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

function tableSql(home: string): Record<string, string> {
  return inspect(home, db => {
    const rows = db.prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all() as { name: string; sql: string }[]
    return Object.fromEntries(rows.map(row => [row.name, row.sql]))
  })
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
 * Deliberately partial pre-migration tree: core tables are missing (as after
 * a crash during first creation) and the outbox predates `idempotency_key`,
 * `attempts`, and `next_attempt_at`.
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

  it('completes a partial legacy database without rewriting its tables or data', () => {
    const home = tempHome()
    const db = new DatabaseSync(dbPath(home))
    db.exec(LEGACY_SCHEMA)
    db.prepare('INSERT INTO documents(kind, id, payload) VALUES(?, ?, ?)')
      .run('note', 'doc_1', JSON.stringify({ body: 'keep me', nested: { n: 7 } }))
    db.prepare('INSERT INTO spills(id, body, created_at) VALUES(?, ?, ?)')
      .run('legacy_spill_1', 'legacy spill body', '2026-01-01T00:00:00.000Z')
    db.close()

    const legacySql = tableSql(home)

    const store = new Store(home)
    expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    expect(store.getDoc('note', 'doc_1')).toEqual({ body: 'keep me', nested: { n: 7 } })
    expect(store.getSpill('legacy_spill_1')).toBe('legacy spill body')
    // Version 1 fills in the tables the partial tree was missing, so core
    // Store operations work after migration.
    expect(store.putSpill('post-migration spill')).toBe('spill_1')
    expect(store.getSpill('spill_1')).toBe('post-migration spill')
    store.close()

    expect(migrationRows(home).map(row => row.version)).toEqual(
      Array.from({ length: LATEST_SCHEMA_VERSION }, (_, index) => index + 1),
    )
    const columns = outboxColumns(home)
    for (const column of ['idempotency_key', 'attempts', 'next_attempt_at']) {
      expect(columns).toContain(column)
    }
    // Missing core tables are created; existing tables and rows are not
    // recreated or rewritten. The outbox DDL changes only because version 2
    // adds columns with ALTER TABLE.
    const tablesAfter = tableNames(home)
    for (const table of ['id_seq', 'spill_grants', 'subscriptions', 'artifacts', 'events']) {
      expect(tablesAfter).toContain(table)
    }
    const sqlAfter = tableSql(home)
    for (const [table, sql] of Object.entries(legacySql)) {
      if (table === 'outbox') continue
      expect(sqlAfter[table]).toBe(sql)
    }
    expect(rawDocument(home, 'note', 'doc_1')).toBe(JSON.stringify({ body: 'keep me', nested: { n: 7 } }))
    expect(rawSpill(home, 'legacy_spill_1')).toBe('legacy spill body')
  })

  it('serializes a second connection opening the same database', () => {
    const home = tempHome()
    const first = new DatabaseSync(dbPath(home))
    const second = new DatabaseSync(dbPath(home))
    try {
      expect(migrate(first, MIGRATIONS, LATEST_SCHEMA_VERSION)).toBe(LATEST_SCHEMA_VERSION)
      const rowsAfterFirst = first.prepare(
        'SELECT version, applied_at FROM schema_migrations ORDER BY version',
      ).all() as { version: number; applied_at: string }[]

      // The second opener re-reads the ledger and finds nothing left to do.
      expect(migrate(second, MIGRATIONS, LATEST_SCHEMA_VERSION)).toBe(LATEST_SCHEMA_VERSION)
      const rowsAfterSecond = second.prepare(
        'SELECT version, applied_at FROM schema_migrations ORDER BY version',
      ).all() as { version: number; applied_at: string }[]
      expect(rowsAfterSecond).toEqual(rowsAfterFirst)
      expect(new Set(rowsAfterSecond.map(row => row.version)).size).toBe(LATEST_SCHEMA_VERSION)
    } finally {
      second.close()
      first.close()
    }
  })

  it('serializes two processes opening a fresh database at the same time', async () => {
    const home = tempHome()
    const script = path.join(home, 'opener.mjs')
    fs.writeFileSync(script, OPENER_SCRIPT)
    const schemaPath = fileURLToPath(new URL('../src/store/schema.ts', import.meta.url))
    const startAt = Date.now() + 400
    const results = await Promise.all([0, 1].map(() =>
      execFileAsync(
        process.execPath,
        ['--experimental-strip-types', script, schemaPath, dbPath(home), String(startAt)],
        { encoding: 'utf8', timeout: 15_000 },
      ),
    ))
    for (const result of results) {
      expect(String(result.stdout).trim()).toBe(String(LATEST_SCHEMA_VERSION))
    }
    expect(migrationRows(home).map(row => row.version)).toEqual(
      Array.from({ length: LATEST_SCHEMA_VERSION }, (_, index) => index + 1),
    )
    const reopened = new Store(home)
    expect(reopened.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    reopened.close()
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

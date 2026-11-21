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
const publishBinding = {
  repo: 'owner/repo',
  head: 'a'.repeat(40),
  branch: 'peanut/store-test',
  base: 'main' as const,
  title: 'Store test binding',
}
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

const ADMISSION_SCRIPT = `
import { pathToFileURL } from 'node:url'
const [storePath, home, startAtRaw] = process.argv.slice(2)
const { Store } = await import(pathToFileURL(storePath).href)
const store = new Store(home)
try {
  const waitMs = Number(startAtRaw) - Date.now()
  if (waitMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs)
  process.stdout.write(store.admitPublishApprovalOnce({ ticketId: 'ticket_process-race', approvalId: 'approval_shared', binding: { repo: 'owner/repo', head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', branch: 'peanut/store-test', base: 'main', title: 'Store test binding' } }) ? 'admitted' : 'denied')
} finally {
  store.close()
}
`

const CRASH_AFTER_ADMISSION_SCRIPT = `
import { pathToFileURL } from 'node:url'
const [storePath, home] = process.argv.slice(2)
const { Store } = await import(pathToFileURL(storePath).href)
const store = new Store(home)
store.admitPublishApprovalOnce({
  ticketId: 'ticket_crashed_after_admission',
  approvalId: 'approval_crashed',
  binding: { repo: 'owner/repo', head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', branch: 'peanut/crashed', base: 'main', title: 'Crash fixture' },
})
process.exit(71)
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
  return tableColumns(home, 'outbox')
}

function tableColumns(home: string, table: string): string[] {
  return inspect(home, db =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name),
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
    expect(tableNames(home)).toContain('publish_approval_admissions')
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
      // Version 2 adds outbox columns; version 4 adds spill refs. Both use
      // ALTER TABLE, so only those two DDL strings change.
      if (table === 'outbox' || table === 'spills') continue
      expect(sqlAfter[table]).toBe(sql)
    }
    expect(tableColumns(home, 'spills')).toContain('refs')
    expect(rawDocument(home, 'note', 'doc_1')).toBe(JSON.stringify({ body: 'keep me', nested: { n: 7 } }))
    expect(rawSpill(home, 'legacy_spill_1')).toBe('legacy spill body')
  })

  it('adds admission state without rewriting a legacy approved Ticket', () => {
    const home = tempHome()
    const legacyTicket = {
      id: 'ticket_legacy',
      collab: { approvals: [{
        id: 'approval_legacy',
        at: '2026-01-01T00:00:00.000Z',
        action: 'publish feature PR',
        requestedBy: 'worker_1',
        status: 'approved',
        decidedAt: '2026-01-01T00:01:00.000Z',
        decidedBy: 'human',
        publish: { repo: 'o/r', head: 'a'.repeat(40), branch: 'peanut/old', base: 'main', title: 'old title' },
      }] },
    }
    const legacyPayload = JSON.stringify(legacyTicket)
    const db = new DatabaseSync(dbPath(home))
    migrate(db, MIGRATIONS.slice(0, 4), 4)
    db.prepare('INSERT INTO documents(kind, id, payload) VALUES(?, ?, ?)')
      .run('ticket', 'ticket_legacy', legacyPayload)
    db.close()

    const upgraded = new Store(home)
    try {
      expect(upgraded.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
      expect(rawDocument(home, 'ticket', 'ticket_legacy')).toBe(legacyPayload)
      expect(upgraded.admitPublishApprovalOnce({ ticketId: 'ticket_legacy', approvalId: 'approval_legacy', binding: publishBinding })).toBe(true)
      expect(upgraded.admitPublishApprovalOnce({ ticketId: 'ticket_legacy', approvalId: 'approval_legacy', binding: publishBinding })).toBe(false)
    } finally {
      upgraded.close()
    }
  })

  it('persists immutable publish identity and explicit publisher observations across reopen', () => {
    const home = tempHome()
    const binding = {
      repo: 'owner/repo',
      head: 'c'.repeat(40),
      branch: 'peanut/frozen-binding',
      base: 'main' as const,
      title: 'Frozen title',
      body: 'Frozen body',
    }
    const first = new Store(home)
    expect(first.admitPublishApprovalOnce({
      ticketId: 'ticket_facts', approvalId: 'approval_facts', binding,
    })).toBe(true)
    expect(first.listPublishAdmissions('ticket_facts')[0]).toMatchObject({
      approvalId: 'approval_facts', binding, observationState: 'admitted',
    })
    first.markPublishAttemptStarted('ticket_facts', 'approval_facts')
    expect(first.listPublishAdmissions('ticket_facts')[0]?.observationState).toBe('attempt_started')
    first.close()

    const reopened = new Store(home)
    try {
      expect(reopened.admitPublishApprovalOnce({
        ticketId: 'ticket_facts', approvalId: 'approval_facts', binding: { ...binding, head: 'd'.repeat(40) },
      })).toBe(false)
      const returned = { number: 12, branch: binding.branch, remote: 'owner/repo' }
      reopened.recordPublishReturned('ticket_facts', 'approval_facts', returned)
      expect(reopened.listPublishAdmissions('ticket_facts')[0]).toMatchObject({
        binding, result: returned, observationState: 'returned', observedAt: expect.any(String),
      })
    } finally {
      reopened.close()
    }
  })

  it('upgrades consumed v5 admissions without fabricating binding or outcome facts', () => {
    const home = tempHome()
    const ticketPayload = JSON.stringify({ id: 'ticket_v5', title: 'historical bytes' })
    const db = new DatabaseSync(dbPath(home))
    migrate(db, MIGRATIONS.slice(0, 5), 5)
    db.prepare('INSERT INTO documents(kind, id, payload) VALUES(?, ?, ?)')
      .run('ticket', 'ticket_v5', ticketPayload)
    db.prepare(`INSERT INTO publish_approval_admissions(ticket_id, approval_id, admitted_at)
                VALUES(?, ?, ?)`)
      .run('ticket_v5', 'approval_v5', '2026-11-20T00:00:00.000Z')
    db.close()

    const upgraded = new Store(home)
    try {
      expect(upgraded.schemaVersion).toBe(6)
      expect(upgraded.listPublishAdmissions('ticket_v5')).toEqual([{
        ticketId: 'ticket_v5',
        approvalId: 'approval_v5',
        admittedAt: '2026-11-20T00:00:00.000Z',
        observationState: 'legacy_unrecorded',
      }])
    } finally {
      upgraded.close()
    }
    expect(rawDocument(home, 'ticket', 'ticket_v5')).toBe(ticketPayload)

    const olderDb = new DatabaseSync(dbPath(home))
    try {
      expect(() => migrate(olderDb, MIGRATIONS.slice(0, 5), 5)).toThrow(/newer than this build supports \(5\)/)
    } finally {
      olderDb.close()
    }
    const reopened = new Store(home)
    try {
      expect(reopened.listPublishAdmissions('ticket_v5')[0]?.observationState).toBe('legacy_unrecorded')
    } finally {
      reopened.close()
    }
  })

  it('preserves consumed admission when a process crashes before publisher entry', async () => {
    const home = tempHome()
    const script = path.join(home, 'crash-after-admission.mjs')
    fs.writeFileSync(script, CRASH_AFTER_ADMISSION_SCRIPT)
    const storePath = fileURLToPath(new URL('../src/store/sqlite.ts', import.meta.url))
    const crashed = await execFileAsync(
      process.execPath,
      ['--experimental-strip-types', script, storePath, home],
      { encoding: 'utf8', timeout: 15_000 },
    ).then(() => undefined, error => error as { code?: number })
    expect(crashed).toMatchObject({ code: 71 })

    const reopened = new Store(home)
    try {
      expect(reopened.listPublishAdmissions('ticket_crashed_after_admission')[0]).toMatchObject({
        approvalId: 'approval_crashed',
        observationState: 'admitted',
      })
      expect(reopened.admitPublishApprovalOnce({
        ticketId: 'ticket_crashed_after_admission',
        approvalId: 'approval_crashed',
        binding: publishBinding,
      })).toBe(false)
    } finally {
      reopened.close()
    }
  })

  it('admits one approval once across independent processes and preserves it after reopen', async () => {
    const home = tempHome()
    const initial = new Store(home)
    initial.close()

    const script = path.join(home, 'admit-once.mjs')
    fs.writeFileSync(script, ADMISSION_SCRIPT)
    const storePath = fileURLToPath(new URL('../src/store/sqlite.ts', import.meta.url))
    const startAt = Date.now() + 500
    const results = await Promise.all([0, 1].map(() =>
      execFileAsync(
        process.execPath,
        ['--experimental-strip-types', script, storePath, home, String(startAt)],
        { encoding: 'utf8', timeout: 15_000 },
      ),
    ))
    expect(results.map(result => String(result.stdout).trim()).sort()).toEqual(['admitted', 'denied'])

    const reopened = new Store(home)
    try {
      expect(reopened.admitPublishApprovalOnce({ ticketId: 'ticket_process-race', approvalId: 'approval_shared', binding: publishBinding })).toBe(false)
      expect(reopened.admitPublishApprovalOnce({ ticketId: 'ticket_process-race', approvalId: 'approval_other', binding: publishBinding })).toBe(true)
      expect(reopened.admitPublishApprovalOnce({ ticketId: 'ticket_other', approvalId: 'approval_shared', binding: publishBinding })).toBe(true)
    } finally {
      reopened.close()
    }
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

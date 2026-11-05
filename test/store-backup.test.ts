import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { UserError } from '../src/shared/errors.ts'
import { LATEST_SCHEMA_VERSION } from '../src/store/schema.ts'
import { Store } from '../src/store/sqlite.ts'
import {
  backupStore,
  restoreStore,
  STORE_DB_FILE,
  STORE_SPILL_DIRS,
} from '../src/store/backup.ts'

const roots: string[] = []
const stores: Store[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function openStore(home: string): Store {
  const store = new Store(home)
  stores.push(store)
  return store
}

function dbPath(home: string): string {
  return path.join(home, STORE_DB_FILE)
}

/** Temporary snapshot names left in an output directory. */
function backupTempNames(dir: string): string[] {
  return fs.readdirSync(dir).filter(name => name.includes('.backup-') && name.endsWith('.tmp'))
}

function inspect<T>(file: string, work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return work(db)
  } finally {
    db.close()
  }
}

function documentPayload(file: string, kind: string, id: string): string | undefined {
  return inspect(file, db =>
    (db.prepare('SELECT payload FROM documents WHERE kind = ? AND id = ?')
      .get(kind, id) as { payload: string } | undefined)?.payload,
  )
}

function expectUserError(work: () => unknown, pattern: RegExp): void {
  try {
    work()
  } catch (error) {
    expect(error).toBeInstanceOf(UserError)
    expect((error as Error).message).toMatch(pattern)
    return
  }
  throw new Error('expected the operation to throw UserError')
}

/**
 * A database whose header, schema, and migration ledger parse, but whose
 * `corrupt_me` b-tree root page has an invalid page-type byte. `integrity_check`
 * must reject it; `MAX(version)` still reads successfully.
 */
function writeCorruptButParseableBackup(file: string): void {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA page_size = 4096;')
  db.exec(`
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
INSERT INTO schema_migrations(version, applied_at) VALUES(${LATEST_SCHEMA_VERSION}, 'test');
CREATE TABLE corrupt_me (id INTEGER PRIMARY KEY, body TEXT);
`)
  const insert = db.prepare('INSERT INTO corrupt_me(body) VALUES(?)')
  for (let index = 0; index < 200; index += 1) insert.run(`${'x'.repeat(200)}-${index}`)
  const row = db.prepare(
    `SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'corrupt_me'`,
  ).get() as { rootpage: number }
  expect(row.rootpage).toBeGreaterThan(1)
  db.close()

  const fd = fs.openSync(file, 'r+')
  try {
    // Page type 0x00 is not a valid b-tree page header.
    fs.writeSync(fd, Buffer.from([0x00]), 0, 1, (row.rootpage - 1) * 4096)
  } finally {
    fs.closeSync(fd)
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      // The test may already have closed it.
    }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('backupStore', () => {
  it('snapshots committed writes that are still only in the WAL', () => {
    const home = tempDir('ds-agent-backup-wal-')
    const out = path.join(tempDir('ds-agent-backup-out-'), 'snapshot.db')
    const store = openStore(home)

    store.putDoc('ticket', 'T1', { id: 'T1', title: 'first' })
    const wal = `${dbPath(home)}-wal`
    expect(fs.existsSync(wal)).toBe(true)
    expect(fs.statSync(wal).size).toBeGreaterThan(0)

    const result = backupStore(home, out)
    expect(result.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    expect(result.bytes).toBe(fs.statSync(out).size)
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.sha256).toBe(
      createHash('sha256').update(fs.readFileSync(out)).digest('hex'),
    )
    expect(fs.statSync(out).mode & 0o777).toBe(0o600)

    // The snapshot includes the uncheckpointed row.
    expect(documentPayload(out, 'ticket', 'T1')).toContain('first')

    // A later live write is not in the already-taken snapshot.
    store.putDoc('ticket', 'T2', { id: 'T2', title: 'second' })
    expect(documentPayload(out, 'ticket', 'T2')).toBeUndefined()
    store.close()
  })

  it('refuses to overwrite an existing output', () => {
    const home = tempDir('ds-agent-backup-refuse-')
    const outDir = tempDir('ds-agent-backup-refuse-out-')
    const out = path.join(outDir, 'existing.db')
    openStore(home).close()
    fs.writeFileSync(out, 'do not replace me')

    expectUserError(() => backupStore(home, out), /already exists/)
    expect(fs.readFileSync(out, 'utf8')).toBe('do not replace me')
  })

  it('refuses a corrupt live store before creating any output', () => {
    const home = tempDir('ds-agent-backup-corrupt-source-')
    const outDir = tempDir('ds-agent-backup-corrupt-source-out-')
    const out = path.join(outDir, 'snapshot.db')

    writeCorruptButParseableBackup(dbPath(home))

    expectUserError(
      () => backupStore(home, out),
      /store integrity check failed/,
    )
    expect(fs.existsSync(out)).toBe(false)
    expect(backupTempNames(outDir)).toEqual([])
  })

  it('preserves a file that appears before install when the backup later fails', () => {
    const home = tempDir('ds-agent-backup-failure-preserve-')
    const outDir = tempDir('ds-agent-backup-failure-preserve-out-')
    const out = path.join(outDir, 'snapshot.db')
    const sentinel = 'created by another process, must survive'
    openStore(home).close()

    expectUserError(
      () => backupStore(home, out, {
        beforeInstall: () => {
          fs.writeFileSync(out, sentinel)
          throw new Error('injected failure after out appeared')
        },
      }),
      /backup failed: injected failure after out appeared/,
    )

    expect(fs.readFileSync(out, 'utf8')).toBe(sentinel)
    expect(backupTempNames(outDir)).toEqual([])
  })

  it('refuses a race-created output without touching it', () => {
    const home = tempDir('ds-agent-backup-race-')
    const outDir = tempDir('ds-agent-backup-race-out-')
    const out = path.join(outDir, 'snapshot.db')
    const sentinel = 'race winner'
    openStore(home).close()

    expectUserError(
      () => backupStore(home, out, {
        beforeInstall: () => {
          fs.writeFileSync(out, sentinel)
        },
      }),
      /already exists/,
    )

    expect(fs.readFileSync(out, 'utf8')).toBe(sentinel)
    expect(backupTempNames(outDir)).toEqual([])
  })

  it('refuses a snapshot whose ledger does not match the source version', () => {
    const home = tempDir('ds-agent-backup-schema-mismatch-')
    const outDir = tempDir('ds-agent-backup-schema-mismatch-out-')
    const out = path.join(outDir, 'snapshot.db')
    openStore(home).close()

    expectUserError(
      () => backupStore(home, out, {
        beforeSnapshotVerify: temp => {
          const snapshot = new DatabaseSync(temp)
          try {
            snapshot.exec('DELETE FROM schema_migrations')
          } finally {
            snapshot.close()
          }
        },
      }),
      /does not match the source version/,
    )

    expect(fs.existsSync(out)).toBe(false)
    expect(backupTempNames(outDir)).toEqual([])
  })

  it('refuses the live database and spill directories', () => {
    const home = tempDir('ds-agent-backup-paths-')
    openStore(home).close()
    const spill = path.join(home, STORE_SPILL_DIRS[0])
    fs.mkdirSync(spill)

    expectUserError(
      () => backupStore(home, dbPath(home)),
      /live store|already exists/,
    )
    expectUserError(
      () => backupStore(home, path.join(spill, 'snapshot.db')),
      /spill directory/,
    )
  })

  it('requires a .db or .sqlite extension unless explicitly allowed', () => {
    const home = tempDir('ds-agent-backup-extension-')
    const outDir = tempDir('ds-agent-backup-extension-out-')
    openStore(home).close()

    expectUserError(
      () => backupStore(home, path.join(outDir, 'snapshot.txt')),
      /\.db or \.sqlite/,
    )
    const result = backupStore(
      home,
      path.join(outDir, 'snapshot.txt'),
      { allowUnknownExtension: true },
    )
    expect(result.bytes).toBeGreaterThan(0)
  })

  it('refuses an empty home with an actionable message', () => {
    const home = tempDir('ds-agent-backup-empty-')
    const out = path.join(tempDir('ds-agent-backup-empty-out-'), 'snapshot.db')
    expectUserError(() => backupStore(home, out), /no store at .*ds-agent\.db/)
  })

  it('refuses to back up a store recorded by a newer schema version', () => {
    const home = tempDir('ds-agent-backup-future-')
    const out = path.join(tempDir('ds-agent-backup-future-out-'), 'snapshot.db')

    const db = new DatabaseSync(dbPath(home))
    db.exec(`
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`)
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)')
      .run(LATEST_SCHEMA_VERSION + 1, new Date().toISOString())
    db.close()

    expectUserError(
      () => backupStore(home, out),
      new RegExp(`schema version ${LATEST_SCHEMA_VERSION + 1} is newer`),
    )
    expect(fs.existsSync(out)).toBe(false)
  })
})

describe('restoreStore', () => {
  it('restores a backup round-trip', () => {
    const home = tempDir('ds-agent-restore-roundtrip-')
    const out = path.join(tempDir('ds-agent-restore-roundtrip-out-'), 'snapshot.db')

    const store = openStore(home)
    store.putDoc('ticket', 'T1', { id: 'T1', title: 'original' })
    store.close()

    const backup = backupStore(home, out)

    // Diverge the live database after the backup.
    const changed = openStore(home)
    changed.deleteDoc('ticket', 'T1')
    changed.putDoc('ticket', 'T9', { id: 'T9', title: 'after backup' })
    changed.close()

    const restored = restoreStore(home, out, { force: true })
    expect(restored.schemaVersion).toBe(backup.schemaVersion)
    expect(restored.bytes).toBe(fs.statSync(out).size)
    expect(restored.sha256).toBe(
      createHash('sha256').update(fs.readFileSync(out)).digest('hex'),
    )

    // The replaced set is retained, not deleted, in a private backups dir.
    const backupsDir = path.join(home, 'backups')
    expect(fs.statSync(backupsDir).mode & 0o777).toBe(0o700)
    const preRestore = fs.readdirSync(backupsDir)
      .find(name => name.startsWith('pre-restore-') && name.endsWith('.db'))
    expect(preRestore).toBeDefined()
    expect(fs.statSync(path.join(backupsDir, preRestore!)).mode & 0o777).toBe(0o600)
    expect(documentPayload(path.join(backupsDir, preRestore!), 'ticket', 'T9'))
      .toContain('after backup')

    const reopened = openStore(home)
    expect(reopened.getDoc<{ title: string }>('ticket', 'T1')?.title).toBe('original')
    expect(reopened.getDoc('ticket', 'T9')).toBeUndefined()
    reopened.close()
  })

  it('refuses to replace an existing store without force', () => {
    const home = tempDir('ds-agent-restore-noforce-')
    const out = path.join(tempDir('ds-agent-restore-noforce-out-'), 'snapshot.db')

    const store = openStore(home)
    store.putDoc('ticket', 'T1', { id: 'T1', title: 'live row' })
    store.close()
    backupStore(home, out)

    expectUserError(() => restoreStore(home, out), /--force/)
    expect(fs.existsSync(path.join(home, 'backups'))).toBe(false)

    const reopened = openStore(home)
    expect(reopened.getDoc<{ title: string }>('ticket', 'T1')?.title).toBe('live row')
    reopened.close()
  })

  it('refuses a corrupt but parseable backup without touching the live store', () => {
    const home = tempDir('ds-agent-restore-corrupt-')
    const outDir = tempDir('ds-agent-restore-corrupt-out-')
    const corrupt = path.join(outDir, 'corrupt.db')

    const store = openStore(home)
    store.putDoc('ticket', 'T1', { id: 'T1', title: 'must survive' })
    store.close()
    const before = fs.readFileSync(dbPath(home))

    writeCorruptButParseableBackup(corrupt)
    // The header and ledger still read; only page integrity fails.
    expect(inspect(corrupt, db =>
      (db.prepare('SELECT MAX(version) AS version FROM schema_migrations')
        .get() as { version: number }).version,
    )).toBe(LATEST_SCHEMA_VERSION)

    expectUserError(
      () => restoreStore(home, corrupt, { force: true }),
      /backup integrity check failed/,
    )

    expect(fs.readFileSync(dbPath(home)).equals(before)).toBe(true)
    expect(fs.existsSync(path.join(home, 'backups'))).toBe(false)
    const reopened = openStore(home)
    expect(reopened.getDoc<{ title: string }>('ticket', 'T1')?.title).toBe('must survive')
    reopened.close()
  })

  it('rolls the old database and WAL back when install fails after the move', () => {
    const home = tempDir('ds-agent-restore-install-failure-')
    const out = path.join(tempDir('ds-agent-restore-install-failure-out-'), 'snapshot.db')

    const store = openStore(home)
    store.putDoc('ticket', 'T1', { id: 'T1', title: 'keep me' })
    backupStore(home, out)

    const wal = `${dbPath(home)}-wal`
    expect(fs.existsSync(wal)).toBe(true)
    expect(fs.statSync(wal).size).toBeGreaterThan(0)

    expectUserError(
      () => restoreStore(home, out, {
        force: true,
        replace: () => {
          throw new Error('injected install failure')
        },
      }),
      /restore failed: injected install failure/,
    )

    // The old set is back in place and still readable, including its WAL.
    expect(fs.existsSync(dbPath(home))).toBe(true)
    expect(fs.existsSync(wal)).toBe(true)
    expect(fs.statSync(wal).size).toBeGreaterThan(0)
    expect(store.getDoc<{ title: string }>('ticket', 'T1')?.title).toBe('keep me')
    expect(fs.readdirSync(home).filter(name => name.includes('.restore-'))).toEqual([])
    expect(fs.readdirSync(path.join(home, 'backups'))).toEqual([])
    store.close()
  })

  it('refuses a backup recorded by a newer schema version', () => {
    const home = tempDir('ds-agent-restore-future-')
    const outDir = tempDir('ds-agent-restore-future-out-')
    const future = path.join(outDir, 'future.db')

    const db = new DatabaseSync(future)
    db.exec(`
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`)
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)')
      .run(LATEST_SCHEMA_VERSION + 1, new Date().toISOString())
    db.close()

    expectUserError(
      () => restoreStore(home, future),
      new RegExp(`schema version ${LATEST_SCHEMA_VERSION + 1} is newer`),
    )
    expect(fs.existsSync(dbPath(home))).toBe(false)
  })

  it('removes stale -wal and -shm sidecars', () => {
    const home = tempDir('ds-agent-restore-sidecars-')
    const out = path.join(tempDir('ds-agent-restore-sidecars-out-'), 'snapshot.db')

    const store = openStore(home)
    store.putDoc('ticket', 'T1', { id: 'T1', title: 'before' })
    store.close()
    backupStore(home, out)

    const wal = `${dbPath(home)}-wal`
    const shm = `${dbPath(home)}-shm`
    fs.writeFileSync(wal, 'stale wal')
    fs.writeFileSync(shm, 'stale shm')
    expect(fs.existsSync(wal)).toBe(true)
    expect(fs.existsSync(shm)).toBe(true)

    restoreStore(home, out, { force: true })
    expect(fs.existsSync(wal)).toBe(false)
    expect(fs.existsSync(shm)).toBe(false)

    const reopened = openStore(home)
    expect(reopened.getDoc<{ title: string }>('ticket', 'T1')?.title).toBe('before')
    reopened.close()
  })

  it('restores a legacy database with no schema_migrations ledger', () => {
    const home = tempDir('ds-agent-restore-legacy-')
    const outDir = tempDir('ds-agent-restore-legacy-out-')
    const legacy = path.join(outDir, 'legacy.sqlite')

    const db = new DatabaseSync(legacy)
    db.exec(`
CREATE TABLE documents (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
`)
    db.prepare('INSERT INTO documents(kind, id, payload) VALUES(?, ?, ?)')
      .run('ticket', 'L1', JSON.stringify({ id: 'L1', title: 'legacy row' }))
    db.close()

    const restored = restoreStore(home, legacy)
    expect(restored.schemaVersion).toBe(0)

    const migrated = openStore(home)
    expect(migrated.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    expect(migrated.getDoc<{ title: string }>('ticket', 'L1')?.title).toBe('legacy row')
    migrated.close()
  })

  it('refuses a missing or invalid backup file', () => {
    const home = tempDir('ds-agent-restore-invalid-')
    const outDir = tempDir('ds-agent-restore-invalid-out-')
    const missing = path.join(outDir, 'missing.db')
    const invalid = path.join(outDir, 'invalid.db')
    fs.writeFileSync(invalid, 'not a database')

    expectUserError(() => restoreStore(home, missing), /backup file not found/)
    expectUserError(
      () => restoreStore(home, invalid),
      /not a valid SQLite backup|integrity check failed/,
    )
  })
})

import { afterEach, describe, expect, it } from 'vitest'
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

    const restored = restoreStore(home, out)
    expect(restored.schemaVersion).toBe(backup.schemaVersion)
    expect(restored.bytes).toBe(fs.statSync(out).size)

    const reopened = openStore(home)
    expect(reopened.getDoc<{ title: string }>('ticket', 'T1')?.title).toBe('original')
    expect(reopened.getDoc('ticket', 'T9')).toBeUndefined()
    reopened.close()
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

    restoreStore(home, out)
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
    expectUserError(() => restoreStore(home, invalid), /not a valid SQLite backup/)
  })
})

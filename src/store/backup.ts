/**
 * WAL-safe backup and restore for the single-file SQLite store.
 *
 * `backupStore` uses `VACUUM INTO`, which produces a consistent snapshot of
 * the database as of the start of that statement. In WAL mode that includes
 * committed frames that have not been checkpointed into the main file yet, so
 * a backup can run while another process is writing (it may briefly wait on
 * the writer's lock).
 *
 * `restoreStore` is deliberately fail-closed and offline:
 *  - it never opens the live store for writing beyond a short lock probe;
 *  - it refuses a backup recorded at a schema version newer than this build;
 *  - it copies to a temporary file in the state home, fsyncs it, removes the
 *    replaced database's stale `-wal`/`-shm` sidecars, and renames it into
 *    place.
 *
 * The target process must be stopped. SQLite does not expose a portable
 * "is this file open elsewhere" call; the lock probe below catches an active
 * writer but is best-effort, not a guarantee.
 */

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { UserError } from '../shared/errors.ts'
import { LATEST_SCHEMA_VERSION } from './schema.ts'

export const STORE_DB_FILE = 'ds-agent.db'

/**
 * Directories under the state home reserved for spill/scratch data. A backup
 * file must not be written inside them: they can be cleaned independently of
 * the database, and a stray `.db` there is easy to mistake for store state.
 * Spill bodies themselves live in the `spills` SQLite table; these names are
 * reserved paths for host-side scratch layers.
 */
export const STORE_SPILL_DIRS = ['spills', 'spill'] as const

const BACKUP_EXTENSIONS = new Set(['.db', '.sqlite'])

export interface StoreBackupResult {
  readonly bytes: number
  readonly schemaVersion: number
  /** SHA-256 of the delivered snapshot, for audit logs. */
  readonly sha256: string
}

export interface StoreRestoreResult {
  readonly schemaVersion: number
  readonly bytes: number
  /** SHA-256 of the backup file that was installed, for audit logs. */
  readonly sha256: string
}

export interface BackupStoreOptions {
  /** Allow an output name that does not end in `.db` or `.sqlite`. */
  readonly allowUnknownExtension?: boolean
  /**
   * Test seam: runs after the SQLite snapshot is written to its temporary
   * path, before the temporary file's ledger/integrity is verified.
   */
  readonly beforeSnapshotVerify?: (temp: string) => void
  /**
   * Test seam: runs after the temporary file is verified and hashed, before
   * the no-overwrite install. A hook may create `out` to exercise the race.
   */
  readonly beforeInstall?: (temp: string, out: string) => void
}

export interface RestoreStoreOptions {
  /**
   * Replace an existing `ds-agent.db`. Without it, restore refuses when a
   * store is present. The old database and its WAL sidecars are moved to
   * `<home>/backups/pre-restore-<timestamp>.db*` before installation.
   */
  readonly force?: boolean
  /**
   * Test seam for the final atomic replace. Production uses `fs.renameSync`.
   * The hook runs after the old store has been moved aside, so a thrown error
   * exercises the rollback path.
   */
  readonly replace?: (from: string, to: string) => void
}

interface SchemaVersionRow {
  version: number | null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** SHA-256 of a file, streamed in fixed-size chunks so large stores are fine. */
function sha256File(file: string): string {
  const hash = createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let read: number
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

/**
 * Refuse a file whose pages are structurally damaged even if its header and
 * schema ledger still parse. `integrity_check` returns exactly one `ok` row
 * for a healthy database; any error or other row means the file must not
 * replace the live store.
 */
function assertIntegrity(db: DatabaseSync, file: string, label: string): void {
  let results: string[]
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]
    results = rows.map(row => String(row.integrity_check))
  } catch (error) {
    throw new UserError(
      `${label} integrity check failed: ${file} (${errorMessage(error)})`,
    )
  }
  if (results.length !== 1 || results[0] !== 'ok') {
    throw new UserError(
      `${label} integrity check failed: ${file} (${results.join('; ') || 'no result'})`,
    )
  }
}

/** Resolve symlinks where possible without requiring the final path to exist. */
function canonicalPath(file: string): string {
  const resolved = path.resolve(file)
  try {
    return fs.realpathSync(resolved)
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved))
    } catch {
      return resolved
    }
  }
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right)
}

/** Read the ledger directly; a database with no ledger is legacy schema 0. */
function readSchemaVersion(db: DatabaseSync): number {
  const table = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`,
  ).get() as { name: string } | undefined
  if (!table) return 0
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations')
    .get() as SchemaVersionRow | undefined
  if (row?.version == null) return 0
  const version = Number(row.version)
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new UserError(`invalid schema version ${String(row.version)} in schema_migrations`)
  }
  return version
}

function fsyncFile(file: string): void {
  const fd = fs.openSync(file, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/** Directory fsync is best-effort: it is unsupported on some platforms. */
function fsyncDirectory(dir: string): void {
  let fd: number | undefined
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    // The rename is still durable on filesystems that refuse directory fsync.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // Already closed.
      }
    }
  }
}

function removeIfExists(file: string): void {
  try {
    fs.rmSync(file, { force: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
  }
}

function validateOutputPath(home: string, outPath: string, options: BackupStoreOptions): void {
  const dbPath = path.join(home, STORE_DB_FILE)
  if (
    samePath(outPath, dbPath)
    || samePath(outPath, `${dbPath}-wal`)
    || samePath(outPath, `${dbPath}-shm`)
  ) {
    throw new UserError(
      `refusing to write a backup over the live store or its WAL sidecars: ${outPath}`,
    )
  }

  const relative = path.relative(home, outPath)
  const insideHome = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  if (insideHome) {
    const first = relative.split(path.sep)[0]
    if ((STORE_SPILL_DIRS as readonly string[]).includes(first)) {
      throw new UserError(
        `refusing to write a backup inside the store spill directory ${path.join(home, first)}; choose a path outside it`,
      )
    }
  }

  if (!options.allowUnknownExtension) {
    const extension = path.extname(outPath).toLowerCase()
    if (!BACKUP_EXTENSIONS.has(extension)) {
      throw new UserError(
        `backup output must end in .db or .sqlite (got ${JSON.stringify(path.basename(outPath))}); `
        + 'pass --allow-any-extension to override',
      )
    }
  }

  try {
    fs.lstatSync(outPath)
    throw new UserError(`backup output already exists: ${outPath}; choose a new path`)
  } catch (error) {
    if (error instanceof UserError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw new UserError(
        `cannot inspect backup output ${outPath}: ${errorMessage(error)}`,
      )
    }
  }

  const parent = path.dirname(outPath)
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new UserError(`backup directory does not exist: ${parent}; create it first`)
  }
}

/** Verify a snapshot's pages and that its ledger matches the source version. */
function verifySnapshot(file: string, expectedVersion: number): void {
  try {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      assertIntegrity(db, file, 'backup snapshot')
      const actual = readSchemaVersion(db)
      if (actual !== expectedVersion) {
        throw new UserError(
          `backup snapshot schema version ${actual} does not match the source version `
          + `${expectedVersion}; retry the backup after the store settles`,
        )
      }
    } finally {
      db.close()
    }
  } catch (error) {
    if (error instanceof UserError) throw error
    throw new UserError(`backup snapshot verification failed: ${file} (${errorMessage(error)})`)
  }
}

/**
 * Snapshot `home`'s store into `outPath`.
 *
 * The output path must not already exist, must not be the live database or a
 * WAL sidecar, must not be inside a reserved spill directory, and normally
 * ends in `.db` or `.sqlite`.
 *
 * The snapshot is written to a unique temporary file in the output directory,
 * verified, hashed, and installed with `linkSync` so a file created by another
 * process in the meantime is never overwritten or deleted. Only the temporary
 * file is cleaned up on failure.
 */
export function backupStore(
  home: string,
  outPath: string,
  options: BackupStoreOptions = {},
): StoreBackupResult {
  const homePath = path.resolve(home)
  const dbPath = path.join(homePath, STORE_DB_FILE)
  const out = path.resolve(outPath)

  validateOutputPath(homePath, out, options)

  if (!fs.existsSync(dbPath)) {
    throw new UserError(
      `no store at ${dbPath}; run "ds-agent init" before backing up`,
    )
  }

  const outDir = path.dirname(out)
  const temp = path.join(
    outDir,
    `.${path.basename(out)}.backup-${process.pid}-${randomUUID()}.tmp`,
  )
  let tempPresent = false
  const db = new DatabaseSync(dbPath)
  try {
    // A writer can hold the lock briefly. VACUUM INTO then snapshots the last
    // committed state, including uncheckpointed WAL frames.
    db.exec('PRAGMA busy_timeout = 5000')
    // Refuse a damaged source before creating any output file.
    assertIntegrity(db, dbPath, 'store')
    const schemaVersion = readSchemaVersion(db)
    if (schemaVersion > LATEST_SCHEMA_VERSION) {
      throw new UserError(
        `store schema version ${schemaVersion} is newer than this build supports `
        + `(${LATEST_SCHEMA_VERSION}); upgrade ds-agent before backing up this store`,
      )
    }

    db.prepare('VACUUM INTO ?').run(temp)
    tempPresent = true
    // The snapshot contains prompts, messages, and spills; keep it private.
    fs.chmodSync(temp, 0o600)
    fsyncFile(temp)

    options.beforeSnapshotVerify?.(temp)
    verifySnapshot(temp, schemaVersion)
    const sha256 = sha256File(temp)

    options.beforeInstall?.(temp, out)
    try {
      // Hard-link install is atomic and fails with EEXIST instead of replacing
      // a file that appeared after validation.
      fs.linkSync(temp, out)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new UserError(`backup output already exists: ${out}; choose a new path`)
      }
      throw error
    }

    try {
      removeIfExists(temp)
      tempPresent = false
    } catch {
      // The output is installed; leaving the extra temporary name is harmless.
    }
    fsyncDirectory(outDir)

    // The hard link shares the inode, but assert the delivered contract.
    if (sha256File(out) !== sha256) {
      throw new UserError(`backup checksum mismatch after install: ${out}`)
    }
    return { bytes: fs.statSync(out).size, schemaVersion, sha256 }
  } catch (error) {
    // Only the temporary file belongs to this call. Never touch `out`: it may
    // have been created by another process after validation.
    if (tempPresent) {
      try {
        removeIfExists(temp)
      } catch {
        // Keep the original failure.
      }
    }
    if (error instanceof UserError) throw error
    throw new UserError(`backup failed: ${errorMessage(error)}`)
  } finally {
    db.close()
  }
}

/**
 * Fail if another connection currently holds a write lock on `target`.
 *
 * This is a best-effort probe. A running ds-agent process that is idle can
 * hold no lock at the instant checked, so the operator must still stop the
 * process before calling restore.
 */
function assertNoActiveWriter(target: string): void {
  if (!fs.existsSync(target)) return

  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(target)
    db.exec('PRAGMA busy_timeout = 0')
    db.exec('BEGIN IMMEDIATE')
    db.exec('ROLLBACK')
  } catch (error) {
    const message = errorMessage(error)
    if (/locked|busy/i.test(message)) {
      throw new UserError(
        `store at ${target} is locked by another process; stop the running ds-agent process before restoring`,
      )
    }
    // An unreadable or corrupt target is exactly what restore is meant to
    // replace, so continue. The copy/rename below still fails closed.
  } finally {
    try {
      db?.close()
    } catch {
      // The probe handle may already be unusable.
    }
  }
}

interface PreRestoreSet {
  readonly db?: string
  readonly wal?: string
  readonly shm?: string
}

/**
 * Move the current database set into `<home>/backups` before installation.
 * The main file moves first so the sidecars cannot be applied to a missing
 * database; a failure rolls the moves back in reverse order.
 */
function moveCurrentStoreAside(home: string, target: string, token: string): PreRestoreSet {
  const dir = path.join(home, 'backups')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let base = path.join(dir, `pre-restore-${stamp}.db`)
  if (fs.existsSync(base)) {
    base = path.join(dir, `pre-restore-${stamp}-${token.slice(-8)}.db`)
  }

  const sourceWal = `${target}-wal`
  const sourceShm = `${target}-shm`
  const hasDb = fs.existsSync(target)
  const hasWal = fs.existsSync(sourceWal)
  const hasShm = fs.existsSync(sourceShm)
  const wal = hasWal ? `${base}-wal` : undefined
  const shm = hasShm ? `${base}-shm` : undefined

  const moved: { from: string; to: string }[] = []
  const move = (from: string, to: string): void => {
    fs.renameSync(from, to)
    moved.push({ from, to })
  }

  try {
    if (hasDb) move(target, base)
    if (wal !== undefined) move(sourceWal, wal)
    if (shm !== undefined) move(sourceShm, shm)
  } catch (error) {
    for (const item of moved.reverse()) {
      try {
        fs.renameSync(item.to, item.from)
      } catch {
        // Keep the original failure; restoreStore reports the partial state.
      }
    }
    throw error
  }

  const privateMode = (file: string | undefined): void => {
    if (file === undefined) return
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      // The move already succeeded; report the original outcome.
    }
  }
  privateMode(hasDb ? base : undefined)
  privateMode(wal)
  privateMode(shm)

  return {
    ...(hasDb ? { db: base } : {}),
    ...(wal === undefined ? {} : { wal }),
    ...(shm === undefined ? {} : { shm }),
  }
}

/** Put the pre-restore set back after a failed install, sidecars first. */
function restorePreRestoreSet(set: PreRestoreSet, target: string): void {
  const moved: { from: string; to: string }[] = []
  const move = (from: string, to: string): void => {
    fs.renameSync(from, to)
    moved.push({ from, to })
  }
  try {
    if (set.wal !== undefined) move(set.wal, `${target}-wal`)
    if (set.shm !== undefined) move(set.shm, `${target}-shm`)
    if (set.db !== undefined) move(set.db, target)
  } catch (error) {
    for (const item of moved.reverse()) {
      try {
        fs.renameSync(item.to, item.from)
      } catch {
        // Keep the original failure.
      }
    }
    throw error
  }
}

/** Verify the copied candidate before it can be installed over the live store. */
function verifyCandidate(file: string, expectedVersion: number): void {
  try {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      assertIntegrity(db, file, 'restore candidate')
      const actual = readSchemaVersion(db)
      if (actual !== expectedVersion) {
        throw new UserError(
          `restore candidate schema version ${actual} does not match the backup version ${expectedVersion}`,
        )
      }
    } finally {
      db.close()
    }
  } catch (error) {
    if (error instanceof UserError) throw error
    throw new UserError(`restore candidate verification failed: ${file} (${errorMessage(error)})`)
  }
}

/**
 * Replace `home`'s store with `backupPath`.
 *
 * The backup must pass `PRAGMA integrity_check`, be a readable SQLite
 * database, and have a recorded schema version no newer than this build.
 * Replacing an existing store requires `force`; the old database and its WAL
 * sidecars are moved to `home/backups/pre-restore-<timestamp>.db*` before the
 * new file is installed. If installation fails, the old set is moved back.
 * Stop the target process first.
 */
export function restoreStore(
  home: string,
  backupPath: string,
  options: RestoreStoreOptions = {},
): StoreRestoreResult {
  const homePath = path.resolve(home)
  const target = path.join(homePath, STORE_DB_FILE)
  const backup = path.resolve(backupPath)
  const force = options.force === true
  const replace = options.replace ?? fs.renameSync

  if (!fs.existsSync(backup) || !fs.statSync(backup).isFile()) {
    throw new UserError(`backup file not found: ${backup}`)
  }
  if (samePath(backup, target)) {
    throw new UserError(`backup path is the live store itself: ${backup}`)
  }

  let schemaVersion: number
  try {
    const source = new DatabaseSync(backup, { readOnly: true })
    try {
      // Validate pages and the ledger before any live-store path is touched.
      assertIntegrity(source, backup, 'backup')
      schemaVersion = readSchemaVersion(source)
    } finally {
      source.close()
    }
  } catch (error) {
    if (error instanceof UserError) throw error
    throw new UserError(
      `not a valid SQLite backup: ${backup} (${errorMessage(error)})`,
    )
  }

  if (schemaVersion > LATEST_SCHEMA_VERSION) {
    throw new UserError(
      `backup schema version ${schemaVersion} is newer than this build supports `
      + `(${LATEST_SCHEMA_VERSION}); upgrade ds-agent before restoring this backup`,
    )
  }

  const targetExists = fs.existsSync(target)
  if (targetExists && !force) {
    throw new UserError(
      `store already exists at ${target}; restoring replaces it. `
      + 'Stop the ds-agent process and re-run with --force; the old database and '
      + `WAL sidecars are moved to ${path.join(homePath, 'backups')} first`,
    )
  }
  if (targetExists && !fs.statSync(target).isFile()) {
    throw new UserError(`store path is not a regular file: ${target}`)
  }

  const sha256 = sha256File(backup)
  fs.mkdirSync(homePath, { recursive: true })
  assertNoActiveWriter(target)

  const token = `${process.pid}-${randomUUID()}`
  const temp = path.join(homePath, `.${STORE_DB_FILE}.restore-${token}.tmp`)
  let installed = false
  let preRestore: PreRestoreSet | undefined
  try {
    // Keep the candidate on the same filesystem as the target; fsync it and
    // verify the copy before moving the old set.
    fs.copyFileSync(backup, temp)
    fs.chmodSync(temp, 0o600)
    fsyncFile(temp)
    verifyCandidate(temp, schemaVersion)
    fsyncDirectory(homePath)

    if (targetExists || fs.existsSync(`${target}-wal`) || fs.existsSync(`${target}-shm`)) {
      preRestore = moveCurrentStoreAside(homePath, target, token)
    }

    replace(temp, target)
    installed = true
    fsyncDirectory(homePath)
  } catch (error) {
    let rollbackError: unknown
    if (preRestore !== undefined && !installed) {
      try {
        restorePreRestoreSet(preRestore, target)
      } catch (failure) {
        rollbackError = failure
      }
    }
    if (rollbackError !== undefined) {
      throw new UserError(
        `restore failed: ${errorMessage(error)}; could not restore the original store `
        + `(pre-restore set: ${preRestore?.db ?? path.join(homePath, 'backups')}): `
        + errorMessage(rollbackError),
      )
    }
    if (error instanceof UserError) throw error
    throw new UserError(`restore failed: ${errorMessage(error)}`)
  } finally {
    if (!installed) {
      try {
        removeIfExists(temp)
      } catch {
        // Keep the original failure.
      }
    }
  }

  return { schemaVersion, bytes: fs.statSync(target).size, sha256 }
}

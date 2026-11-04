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

import { randomUUID } from 'node:crypto'
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
}

export interface StoreRestoreResult {
  readonly schemaVersion: number
  readonly bytes: number
}

export interface BackupStoreOptions {
  /** Allow an output name that does not end in `.db` or `.sqlite`. */
  readonly allowUnknownExtension?: boolean
}

interface SchemaVersionRow {
  version: number | null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
    // ENOENT means the path is free. Anything else (for example EACCES while
    // probing the directory) is left to the filesystem operation below.
  }

  const parent = path.dirname(outPath)
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new UserError(`backup directory does not exist: ${parent}; create it first`)
  }
}

/**
 * Snapshot `home`'s store into `outPath`.
 *
 * The output path must not already exist, must not be the live database or a
 * WAL sidecar, must not be inside a reserved spill directory, and normally
 * ends in `.db` or `.sqlite`.
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

  const db = new DatabaseSync(dbPath)
  try {
    // A writer can hold the lock briefly. VACUUM INTO then snapshots the last
    // committed state, including uncheckpointed WAL frames.
    db.exec('PRAGMA busy_timeout = 5000')
    const schemaVersion = readSchemaVersion(db)
    db.prepare('VACUUM INTO ?').run(out)
    // The snapshot contains prompts, messages, and spills; keep it private.
    fs.chmodSync(out, 0o600)
    fsyncFile(out)
    return { bytes: fs.statSync(out).size, schemaVersion }
  } catch (error) {
    // The output did not exist before this call, so anything here is a partial
    // snapshot and must not block a retry.
    try {
      fs.rmSync(out, { force: true })
    } catch {
      // Keep the original failure.
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

/**
 * Replace `home`'s store with `backupPath`.
 *
 * The backup must be a readable SQLite database whose recorded schema version
 * is no newer than this build. Stop the target process first: the store is
 * replaced in place and stale WAL sidecars are discarded.
 */
export function restoreStore(home: string, backupPath: string): StoreRestoreResult {
  const homePath = path.resolve(home)
  const target = path.join(homePath, STORE_DB_FILE)
  const backup = path.resolve(backupPath)

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

  fs.mkdirSync(homePath, { recursive: true })
  assertNoActiveWriter(target)

  const temp = path.join(homePath, `.${STORE_DB_FILE}.restore-${process.pid}-${randomUUID()}.tmp`)
  let renamed = false
  try {
    fs.copyFileSync(backup, temp)
    fs.chmodSync(temp, 0o600)
    fsyncFile(temp)

    // These sidecars describe the database being replaced. Removing them
    // before the rename prevents SQLite from applying old WAL frames to the
    // restored file on the next open.
    removeIfExists(`${target}-wal`)
    removeIfExists(`${target}-shm`)

    fs.renameSync(temp, target)
    renamed = true
    fsyncDirectory(homePath)
    return { schemaVersion, bytes: fs.statSync(target).size }
  } catch (error) {
    if (error instanceof UserError) throw error
    throw new UserError(`restore failed: ${errorMessage(error)}`)
  } finally {
    if (!renamed) {
      try {
        removeIfExists(temp)
      } catch {
        // Keep the original failure.
      }
    }
  }
}

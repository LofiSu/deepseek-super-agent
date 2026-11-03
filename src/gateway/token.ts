import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const TOKEN_MODE = 0o600
/** Refuse to follow a path swapped for a symlink between lstat and open. */
const NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0

/** Thrown when an existing token file cannot be restricted to mode 0600. */
export class GatewayTokenPermissionError extends Error {
  constructor(file: string, cause: unknown) {
    super(`gateway token file ${file} could not be secured to mode 0600`, { cause })
    this.name = 'GatewayTokenPermissionError'
  }
}

/**
 * Thrown when the token path is not a plain, singly-linked file. A token file
 * in a writable state directory could otherwise be a planted symlink (redirect
 * the bearer token and chmod an arbitrary target) or a hard link to another
 * file. We fail closed instead of reading or chmodding through it.
 */
export class GatewayTokenFileError extends Error {
  constructor(file: string, reason: string) {
    super(`gateway token file ${file} ${reason}; refusing to use it`)
    this.name = 'GatewayTokenFileError'
  }
}

/** Local gateway bearer token lives here (mode 0600) so ds-agent can auto-read it. */
export function gatewayTokenPath(home: string): string {
  return path.join(home, 'gateway.token')
}

function assertPlainTokenFile(file: string, stats: fs.Stats): void {
  if (stats.isSymbolicLink()) throw new GatewayTokenFileError(file, 'is a symbolic link')
  if (!stats.isFile()) throw new GatewayTokenFileError(file, 'is not a regular file')
  if (stats.nlink > 1) throw new GatewayTokenFileError(file, 'has multiple hard links')
}

function assertSameFile(file: string, before: fs.Stats, after: fs.Stats): void {
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new GatewayTokenFileError(file, 'changed while being opened')
  }
}

/**
 * Re-apply 0600 to the already-open token file and verify it stuck. Fails
 * closed: an unsecurable file is never used. Uses `fchmod`/`fstat` on the file
 * descriptor, so a path swapped after the initial `lstat` cannot redirect the
 * chmod.
 *
 * POSIX-only: Windows has no POSIX mode bits (chmod there only toggles the
 * read-only flag), so the mode check is skipped on win32; the plain-file and
 * no-symlink checks still apply.
 */
function ensurePrivateMode(file: string, fd: number): void {
  if (process.platform === 'win32') return
  try {
    const current = fs.fstatSync(fd).mode & 0o777
    if (current !== TOKEN_MODE) fs.fchmodSync(fd, TOKEN_MODE)
    const repaired = fs.fstatSync(fd).mode & 0o777
    if (repaired !== TOKEN_MODE) throw new Error(`mode is 0${repaired.toString(8)}`)
  } catch (error) {
    throw new GatewayTokenPermissionError(file, error)
  }
}

/**
 * Read one token file. Missing/unreadable paths return undefined (callers may
 * mint a token), but a symlink, non-regular file, hard link, or a file that
 * cannot be secured throws so the caller fails closed instead of using it.
 *
 * `ELOOP` means the path was swapped for a symlink (or a symlinked parent)
 * between `lstat` and `open`; `O_NOFOLLOW` refused to follow it. Treating that
 * as "not found" would let a racing attacker make the gateway mint a new token
 * over a path it could not verify, so it is an explicit failure.
 */
function readTokenFile(file: string): string | undefined {
  let before: fs.Stats
  let fd: number
  try {
    before = fs.lstatSync(file)
    assertPlainTokenFile(file, before)
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW)
  } catch (error) {
    if (error instanceof GatewayTokenFileError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new GatewayTokenFileError(file, 'changed while being opened (ELOOP)')
    }
    return undefined
  }
  try {
    // Re-check the opened inode: lstat could race with a link/rename swap.
    const after = fs.fstatSync(fd)
    assertPlainTokenFile(file, after)
    assertSameFile(file, before, after)
    const token = fs.readFileSync(fd, 'utf8').trim()
    ensurePrivateMode(file, fd)
    return token || undefined
  } catch (error) {
    if (error instanceof GatewayTokenPermissionError || error instanceof GatewayTokenFileError) throw error
    return undefined
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Create the token file without ever following a pre-existing path. `O_EXCL`
 * fails on symlinks, directories, and hard links, and `O_NOFOLLOW` protects
 * the platforms where it is available. If another process wins the create
 * race, reuse its private token. Never overwrite the winner's file: while it
 * is still empty it may be mid-write, so returning our token (or writing it
 * over theirs) could make the caller use a value that is not persisted.
 */
function writeTokenFile(file: string, token: string): string | undefined {
  const exclusive = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW
  let created = false
  try {
    const fd = fs.openSync(file, exclusive, TOKEN_MODE)
    created = true
    try {
      assertPlainTokenFile(file, fs.fstatSync(fd))
      fs.writeFileSync(fd, `${token}\n`)
      ensurePrivateMode(file, fd)
    } finally {
      fs.closeSync(fd)
    }
    return undefined
  } catch (error) {
    if (created) {
      // Never leave a partial or rejected token file behind for the next read.
      try { fs.unlinkSync(file) } catch { /* best effort */ }
      throw error
    }
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new GatewayTokenFileError(file, 'changed while being opened (ELOOP)')
    }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const raced = readTokenFile(file)
      if (raced) return raced
      // The file exists but holds no token yet (empty or still being written
      // by the process that won the create race). Returning our freshly
      // minted token here would diverge from what ends up persisted.
      throw new GatewayTokenFileError(file, 'was created concurrently and is empty')
    }
    throw error
  }
}

export function readGatewayToken(home: string): string | undefined {
  return readTokenFile(gatewayTokenPath(home))
}

/**
 * An explicit token wins; otherwise reuse the persisted one; otherwise mint a
 * fresh `gw_<random>` and write it 0600. This is the "gateway gives itself a
 * token, the agent reads it" path — no manual key juggling.
 */
export function loadOrCreateGatewayToken(home: string, override?: string): string {
  const explicit = override?.trim()
  if (explicit) return explicit
  const existing = readGatewayToken(home)
  if (existing) return existing
  const token = `gw_${randomBytes(24).toString('hex')}`
  fs.mkdirSync(home, { recursive: true })
  const raced = writeTokenFile(gatewayTokenPath(home), token)
  return raced ?? token
}

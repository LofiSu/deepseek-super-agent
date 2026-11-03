import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const TOKEN_MODE = 0o600

/** Thrown when an existing token file cannot be restricted to mode 0600. */
export class GatewayTokenPermissionError extends Error {
  constructor(file: string, cause: unknown) {
    super(`gateway token file ${file} could not be secured to mode 0600`, { cause })
    this.name = 'GatewayTokenPermissionError'
  }
}

/** Local gateway bearer token lives here (mode 0600) so ds-agent can auto-read it. */
export function gatewayTokenPath(home: string): string {
  return path.join(home, 'gateway.token')
}

/**
 * Re-apply 0600 to a token file and verify it stuck. Fails closed: an
 * unsecurable file is never used. Windows has no POSIX mode bits (chmod there
 * only toggles the read-only flag), so the mode check is POSIX-only.
 */
function ensurePrivateMode(file: string): void {
  if (process.platform === 'win32') return
  try {
    const current = fs.statSync(file).mode & 0o777
    if (current !== TOKEN_MODE) fs.chmodSync(file, TOKEN_MODE)
    const repaired = fs.statSync(file).mode & 0o777
    if (repaired !== TOKEN_MODE) throw new Error(`mode is 0${repaired.toString(8)}`)
  } catch (error) {
    throw new GatewayTokenPermissionError(file, error)
  }
}

export function readGatewayToken(home: string): string | undefined {
  const file = gatewayTokenPath(home)
  let token: string
  try {
    token = fs.readFileSync(file, 'utf8').trim()
  } catch {
    return undefined
  }
  ensurePrivateMode(file)
  return token || undefined
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
  const file = gatewayTokenPath(home)
  fs.writeFileSync(file, `${token}\n`, { mode: TOKEN_MODE })
  ensurePrivateMode(file)
  return token
}

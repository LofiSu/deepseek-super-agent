import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Local gateway bearer token lives here (mode 0600) so ds-agent can auto-read it. */
export function gatewayTokenPath(home: string): string {
  return path.join(home, 'gateway.token')
}

export function readGatewayToken(home: string): string | undefined {
  try {
    const token = fs.readFileSync(gatewayTokenPath(home), 'utf8').trim()
    return token || undefined
  } catch {
    return undefined
  }
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
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  return token
}

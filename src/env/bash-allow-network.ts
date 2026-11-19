import { UserError } from '../shared/errors.ts'

/**
 * Parse `DS_AGENT_BASH_ALLOW_NETWORK`. Unset/empty/`0`/`false` keep network off;
 * `1`/`true` enables it. Any other value fails closed.
 */
export function parseBashAllowNetwork(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DS_AGENT_BASH_ALLOW_NETWORK
  if (raw === undefined) return false
  const value = raw.trim()
  if (value === '' || value === '0' || value === 'false') return false
  if (value === '1' || value === 'true') return true
  throw new UserError(
    `invalid DS_AGENT_BASH_ALLOW_NETWORK: "${raw}" (expected 0, 1, false, or true)`,
  )
}

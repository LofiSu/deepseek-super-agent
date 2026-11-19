import { UserError } from '../shared/errors.ts'

/** Default worker bash timeout when Runtime creates LocalEnv for serve. */
export const BASH_TIMEOUT_SERVE_DEFAULT_MS = 600_000

export const BASH_TIMEOUT_MIN_MS = 1_000
export const BASH_TIMEOUT_MAX_MS = 30 * 60 * 1_000

/**
 * Resolve bash timeout from `DS_AGENT_BASH_TIMEOUT_MS` with serve default and clamps.
 * Garbage values fail closed.
 */
export function parseBashTimeoutMs(
  env: NodeJS.ProcessEnv,
  fallbackMs: number = BASH_TIMEOUT_SERVE_DEFAULT_MS,
): number {
  const raw = env.DS_AGENT_BASH_TIMEOUT_MS
  let ms = fallbackMs
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw.trim())
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new UserError(`invalid DS_AGENT_BASH_TIMEOUT_MS: "${raw}" (expected integer milliseconds)`)
    }
    ms = parsed
  }
  if (ms < BASH_TIMEOUT_MIN_MS || ms > BASH_TIMEOUT_MAX_MS) {
    throw new UserError(
      `bash timeout ${ms}ms out of range [${BASH_TIMEOUT_MIN_MS}, ${BASH_TIMEOUT_MAX_MS}]`,
    )
  }
  return ms
}

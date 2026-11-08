/**
 * Bounded strategy surface: fixed-token alternation only (linear-time match).
 * Rejects arbitrary regex, nested quantifiers, and oversize configuration.
 */

export const MAX_TOKENS_PER_SIDE = 32
export const MAX_TOKEN_LEN = 24
const TOKEN_RE = /^[a-z][a-z0-9' -]{0,23}$/i

export function assertSafeToken(token: string, label: string): void {
  if (token.length > MAX_TOKEN_LEN) throw new Error(`${label} token too long`)
  if (!TOKEN_RE.test(token.trim())) throw new Error(`${label} token invalid charset: ${token}`)
  if (/[.*+?^${}()|[\]\\]/.test(token)) throw new Error(`${label} token must not be regex metachar`)
}

export function tokensToBoundedPattern(tokens: readonly string[]): string {
  if (!tokens.length) throw new Error('at least one token required')
  if (tokens.length > MAX_TOKENS_PER_SIDE) throw new Error('too many tokens')
  const norm = tokens.map(token => {
    const t = token.trim().toLowerCase()
    assertSafeToken(t, 'pattern')
    return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  })
  return `\\b(?:${norm.join('|')})\\b`
}

/** Runtime compile with timeout guard via short input slices in gate (clauses already bounded). */
export function compileBoundedPattern(pattern: string): RegExp {
  if (pattern.length > 4096) throw new Error('pattern too large')
  if (/\(\?:[^)]*\+[^)]*\)/.test(pattern)) throw new Error('nested quantifier forbidden')
  if (/\([^)]*\*[^)]*\)/.test(pattern)) throw new Error('star quantifier group forbidden')
  if (!pattern.startsWith('\\b(?:') || !pattern.endsWith(')\\b')) {
    throw new Error('pattern must be bounded alternation form')
  }
  return new RegExp(pattern, 'i')
}

export function normalizeDirectionKey(positive: readonly string[], negative: readonly string[]): string {
  const p = [...positive].map(t => t.trim().toLowerCase()).sort().join('|')
  const n = [...negative].map(t => t.trim().toLowerCase()).sort().join('|')
  return `p:${p};n:${n}`
}

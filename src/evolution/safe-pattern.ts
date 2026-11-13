/**
 * Bounded strategy surface: fixed-token alternation only (linear-time match).
 * Rejects arbitrary regex, nested quantifiers, and oversize configuration.
 */

export const MAX_TOKENS_PER_SIDE = 32
export const MAX_TOKEN_LEN = 24
const TOKEN_RE = /^[a-z][a-z0-9' -]{0,23}$/i
const BOUNDED_PREFIX = '\\b(?:'
const BOUNDED_SUFFIX = ')\\b'

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

/**
 * Runtime compile for the only accepted grammar: `\b(?:alt1|alt2|...)\b`,
 * where every alternative is a literal token with the same charset as
 * `assertSafeToken` / `tokensToBoundedPattern` output.
 *
 * Validating the whole grammar (instead of a prefix/suffix and a couple of
 * quantifier checks) also rejects nested or unbounded `{n,}` / `{n,m}` / `{n}`
 * forms such as `(a{1,}){1,}`, plus `+`, `*`, `?`, `.`, inner anchors and
 * nested groups.
 */
export function compileBoundedPattern(pattern: string): RegExp {
  if (pattern.length > 4096) throw new Error('pattern too large')
  if (!pattern.startsWith(BOUNDED_PREFIX) || !pattern.endsWith(BOUNDED_SUFFIX)) {
    throw new Error('pattern must be bounded alternation form')
  }
  const inner = pattern.slice(BOUNDED_PREFIX.length, pattern.length - BOUNDED_SUFFIX.length)
  const alternatives = inner.split('|')
  if (alternatives.length > MAX_TOKENS_PER_SIDE) throw new Error('too many tokens')
  for (const alternative of alternatives) {
    // Exact token grammar: letter-led `[A-Za-z0-9' -]` literal. Valid token
    // lists never emit escapes, so a backslash here is outside the grammar.
    if (!TOKEN_RE.test(alternative)) {
      throw new Error(`pattern alternative is not a bounded token literal: ${alternative}`)
    }
  }
  return new RegExp(pattern, 'i')
}

export function normalizeDirectionKey(positive: readonly string[], negative: readonly string[]): string {
  const p = [...positive].map(t => t.trim().toLowerCase()).sort().join('|')
  const n = [...negative].map(t => t.trim().toLowerCase()).sort().join('|')
  return `p:${p};n:${n}`
}

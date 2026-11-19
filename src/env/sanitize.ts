const SECRET_ENV = /(^|_)(API_KEY|APIKEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)($|_)/i

/** Ignore tiny values so a short placeholder cannot punch holes in ordinary text. */
export const MIN_SECRET_LENGTH = 8

/** Names copied into a worker shell. Secret-named entries are dropped even if listed. */
export const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SHELL',
  'TZ',
] as const

export function isSecretEnvName(name: string): boolean {
  return SECRET_ENV.test(name)
}

export function secretValues(env: NodeJS.ProcessEnv): string[] {
  const found: string[] = []
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue
    if (!isSecretEnvName(name)) continue
    found.push(value)
  }
  return [...new Set(found)].sort((a, b) => b.length - a.length)
}

/**
 * Credential shapes that are recognisable without knowing the source file.
 * This covers the common case where a worker `cat`s a credentials file: the
 * value was never in our environment, so `secretValues` cannot know it.
 * It is defense in depth, not a guarantee for arbitrary secret formats.
 */
const CREDENTIAL_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  // A truncated block must not leave key material behind, and the `|$`
  // alternative keeps a header with no end marker a single linear scan.
  { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, replacement: '[redacted]' },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: '[redacted]' },
  // Horizontal whitespace only: an empty assignment must not consume the next line.
  { pattern: /\b(?:aws_secret_access_key|aws_access_key_id|aws_session_token)[ \t]*=[ \t]*\S*/gi, replacement: '[redacted]' },
  // `aws configure export-credentials` JSON fields.
  { pattern: /\b(AccessKeyId|SecretAccessKey|SessionToken)\b("?\s*:\s*")[^"\s,}]+/g, replacement: '$1$2[redacted]' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: '[redacted]' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: '[redacted]' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: '[redacted]' },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: '[redacted]' },
]

export function redactCredentialPatterns(text: string): string {
  let out = text
  for (const { pattern, replacement } of CREDENTIAL_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  const ordered = [...new Set(secrets)]
    .filter(secret => secret.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
  let out = text
  for (const secret of ordered) {
    if (!out.includes(secret)) continue
    out = out.split(secret).join('[redacted]')
  }
  return redactCredentialPatterns(out)
}

/** Redact explicitly identified credentials even when they are short. */
export function redactLiteralSecrets(text: string, secrets: readonly string[]): string {
  const ordered = [...new Set(secrets)]
    .filter(secret => secret.length > 0)
    .sort((a, b) => b.length - a.length)
  let out = text
  for (const secret of ordered) {
    if (out.includes(secret)) out = out.split(secret).join('[redacted]')
  }
  return out
}

/** Match explicit and discovered secrets against the same original text. */
export function redactKnownSecrets(
  text: string,
  explicitSecrets: readonly string[],
  discoveredSecrets: readonly string[],
): string {
  const candidates = [
    ...new Set([
      ...explicitSecrets.filter(secret => secret.length > 0),
      ...discoveredSecrets.filter(secret => secret.length >= MIN_SECRET_LENGTH),
    ]),
  ]
  const matches: { start: number; end: number }[] = []
  for (const secret of candidates) {
    let start = text.indexOf(secret)
    while (start !== -1) {
      matches.push({ start, end: start + secret.length })
      start = text.indexOf(secret, start + 1)
    }
  }
  matches.sort((left, right) => left.start - right.start || right.end - left.end)
  let out = ''
  let cursor = 0
  let index = 0
  while (index < matches.length) {
    let { start, end } = matches[index++]!
    while (index < matches.length && matches[index]!.start <= end) {
      end = Math.max(end, matches[index]!.end)
      index += 1
    }
    out += text.slice(cursor, start) + '[redacted]'
    cursor = end
  }
  out += text.slice(cursor)
  return redactCredentialPatterns(out)
}

export function allowlistedEnv(
  env: NodeJS.ProcessEnv,
  allow: readonly string[] = ENV_ALLOWLIST,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {}
  for (const name of allow) {
    if (isSecretEnvName(name)) continue
    const value = env[name]
    if (typeof value === 'string') next[name] = value
  }
  return next
}

export function redactUnknown(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(item => redactUnknown(item, redact))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactUnknown(inner, redact)
    }
    return out
  }
  return value
}

export function redactRecord(
  value: Record<string, unknown>,
  redact: (text: string) => string,
): Record<string, unknown> {
  return redactUnknown(value, redact) as Record<string, unknown>
}

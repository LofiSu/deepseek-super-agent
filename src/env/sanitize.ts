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

export function redactSecrets(text: string, secrets: readonly string[]): string {
  const ordered = [...new Set(secrets)]
    .filter(secret => secret.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
  let out = text
  for (const secret of ordered) {
    if (!out.includes(secret)) continue
    out = out.split(secret).join('[redacted]')
  }
  return out
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

import { UserError } from '../shared/errors.ts'

export interface McpServerConfig {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  timeoutMs: number
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i
const DEFAULT_TIMEOUT_MS = 120_000

function fail(reason: string): never {
  throw new UserError(`invalid MCP server config: ${reason}`)
}

export function parseMcpServers(raw: unknown): McpServerConfig[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) fail('expected an array')

  const seen = new Set<string>()
  return raw.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('each server must be an object')
    const record = entry as Record<string, unknown>

    const name = record.name
    if (typeof name !== 'string' || !NAME.test(name)) fail('name must match /^[a-z0-9][a-z0-9_-]{0,31}$/i')
    if (seen.has(name)) fail(`duplicate name: ${name}`)
    seen.add(name)

    const command = record.command
    if (typeof command !== 'string' || command.trim() === '') fail('command must be a non-empty string')

    const args = record.args ?? []
    if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) fail('args must be an array of strings')

    const env = record.env ?? {}
    if (!env || typeof env !== 'object' || Array.isArray(env)) fail('env must be an object')
    for (const value of Object.values(env as Record<string, unknown>)) {
      if (typeof value !== 'string') fail('env values must be strings')
    }

    const timeoutMs = record.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      fail('timeoutMs must be a positive integer')
    }

    return {
      name,
      command,
      args: [...args],
      env: { ...(env as Record<string, string>) },
      timeoutMs,
    }
  })
}

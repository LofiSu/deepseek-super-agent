/**
 * Agent config wiring: merge gateway values into an agent's own config file
 * (JSON or KEY=VALUE env), keeping unrelated keys and writing atomically — the
 * generic TS equivalent of Magpie rewriting an agent's model/base config.
 */

import fs from 'node:fs'
import path from 'node:path'

export type WiringFormat = 'json' | 'env'

export function detectFormat(file: string): WiringFormat {
  return file.toLowerCase().endsWith('.json') ? 'json' : 'env'
}

function writeAtomic(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, body)
  fs.renameSync(tmp, file)
}

export function readConfig(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/**
 * Merge `vars` into a config file.
 * - `format: 'json'` merges top-level keys, or under `env` when `envScope` is set
 *   (Claude Code's settings.json keeps base/key under `env`).
 * - `format: 'env'` rewrites matching `KEY=VALUE` lines and appends the rest.
 */
export function wireConfig(
  file: string,
  vars: Record<string, string>,
  opts: { format?: WiringFormat; envScope?: boolean } = {},
): void {
  const format = opts.format ?? detectFormat(file)
  if (format === 'json') {
    const current = readConfig(file)
    if (opts.envScope) {
      const existing = current.env && typeof current.env === 'object' && !Array.isArray(current.env)
        ? current.env as Record<string, string>
        : {}
      current.env = { ...existing, ...vars }
    } else {
      Object.assign(current, vars)
    }
    writeAtomic(file, `${JSON.stringify(current, null, 2)}\n`)
    return
  }
  let lines: string[] = []
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line, index, all) => !(index === all.length - 1 && line === ''))
  } catch {
    lines = []
  }
  const keys = new Set(Object.keys(vars))
  const kept = lines.filter(line => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    return !(match && keys.has(match[1]!))
  })
  for (const [key, value] of Object.entries(vars)) kept.push(`${key}=${value}`)
  writeAtomic(file, `${kept.join('\n')}\n`)
}

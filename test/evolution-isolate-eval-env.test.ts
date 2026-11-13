import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultBaselineStrategy } from '../src/evolution/dataset.ts'
import { buildEvaluatorChildEnv, isolatedEvaluateSplit } from '../src/evolution/isolate-eval.ts'
import type { EvolutionEvalCase } from '../src/evolution/types.ts'

/**
 * Synthetic canaries only. They are deliberately not credential-shaped so a
 * pass can only come from environment isolation, not from redaction.
 */
const CANARY_VALUES = {
  OPENAI_API_KEY: 'canary_openai_9f3c2a1b',
  ANTHROPIC_API_KEY: 'canary_anthropic_9f3c2a1b',
  DEEPSEEK_API_KEY: 'canary_deepseek_9f3c2a1b',
  GITHUB_TOKEN: 'canary_github_9f3c2a1b',
  DS_AGENT_API_KEY: 'canary_ds_agent_9f3c2a1b',
  DS_AGENT_API_BASE: 'http://canary.invalid/9f3c2a1b',
  // Benign on purpose: the eval must still run before the fix, so a failure is
  // an environment-leak assertion rather than a broken child.
  NODE_OPTIONS: '--trace-exit',
} as const

// Match the child script itself, not any process whose arguments merely quote
// the name (e.g. an orchestrator prompt).
const CHILD_MARKER = 'evolution-eval-child.mjs'
const tempDirs: string[] = []
const savedEnv = new Map<string, string | undefined>()

function makeWorkDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-eval-env-'))
  tempDirs.push(dir)
  return dir
}

function installCanaries(): void {
  for (const [name, value] of Object.entries(CANARY_VALUES)) {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name])
    process.env[name] = value
  }
}

function restoreCanaries(): void {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  savedEnv.clear()
}

afterEach(() => {
  restoreCanaries()
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const cases: EvolutionEvalCase[] = [
  { id: 'tr-1', speculative: true, report: { kind: 'ready', text: 'ready fixed reproduced' }, expected: 'deliver' },
]

function readEnviron(pid: number): string | undefined {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, 'utf8')
  } catch {
    // The process exited between the cmdline scan and this read.
    return undefined
  }
}

/**
 * Poll `/proc` for the evaluator child and capture its environment while it is
 * alive. The child is short-lived, so callers retry the bounded number of times
 * and fail if no sample was ever taken.
 */
function watchEvaluatorChild(): { stop: () => void; captured: string[] } {
  const captured: string[] = []
  const seen = new Set<number>()
  let stopped = false
  const scan = (): void => {
    if (stopped) return
    let entries: string[]
    try {
      entries = fs.readdirSync('/proc')
    } catch {
      return
    }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue
      const pid = Number(entry)
      let cmdline: string
      try {
        cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      } catch {
        continue
      }
      if (!cmdline.includes(CHILD_MARKER) || seen.has(pid)) continue
      const environ = readEnviron(pid)
      if (environ === undefined) continue
      seen.add(pid)
      captured.push(environ)
    }
  }
  const timer = setInterval(scan, 1)
  scan()
  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
    captured,
  }
}

describe('buildEvaluatorChildEnv', () => {
  it('keeps allowlisted basics only and roots HOME/TMPDIR in the eval directory', () => {
    const evalDir = makeWorkDir()
    const parentEnv: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      HOME: '/parent/home',
      TMPDIR: '/parent/tmp',
      OPENAI_API_KEY: CANARY_VALUES.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: CANARY_VALUES.ANTHROPIC_API_KEY,
      DEEPSEEK_API_KEY: CANARY_VALUES.DEEPSEEK_API_KEY,
      GITHUB_TOKEN: CANARY_VALUES.GITHUB_TOKEN,
      DS_AGENT_API_KEY: CANARY_VALUES.DS_AGENT_API_KEY,
      DS_AGENT_API_BASE: CANARY_VALUES.DS_AGENT_API_BASE,
      NODE_OPTIONS: '--require /nonexistent/repro.js',
      NODE_PATH: '/nonexistent/node_modules',
      NODE_EXTRA_REQUIRE_EXTENSIONS: '.js',
      LD_PRELOAD: '/nonexistent/preload.so',
      LD_LIBRARY_PATH: '/nonexistent/lib',
      DYLD_INSERT_LIBRARIES: '/nonexistent/dyld.dylib',
    }

    const env = buildEvaluatorChildEnv(evalDir, parentEnv)

    for (const name of [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'DEEPSEEK_API_KEY',
      'GITHUB_TOKEN',
      'DS_AGENT_API_KEY',
      'DS_AGENT_API_BASE',
      'NODE_OPTIONS',
      'NODE_PATH',
      'NODE_EXTRA_REQUIRE_EXTENSIONS',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'DYLD_INSERT_LIBRARIES',
    ]) {
      // Absent entirely, not present with an empty placeholder.
      expect(Object.hasOwn(env, name), name).toBe(false)
    }

    expect(env.HOME).toBe(evalDir)
    expect(env.TMPDIR).toBe(evalDir)
    expect(env.NODE_NO_WARNINGS).toBe('1')
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.LANG).toBe('C.UTF-8')
    expect(env.LC_ALL).toBe('C.UTF-8')
  })
})

describe.skipIf(process.platform !== 'linux')('isolated evaluator child environment', () => {
  it('does not expose secret or Node injection variables to the trusted child', async () => {
    installCanaries()
    let captured: string[] = []
    let lastResult: Awaited<ReturnType<typeof isolatedEvaluateSplit>> | undefined
    // The trusted child only lives for a fraction of a second; retry a bounded
    // number of times so a missed /proc sample does not silently pass.
    for (let attempt = 0; attempt < 8 && captured.length === 0; attempt += 1) {
      const watcher = watchEvaluatorChild()
      try {
        lastResult = await isolatedEvaluateSplit(
          makeWorkDir(),
          defaultBaselineStrategy(),
          'train',
          cases,
          { evalTimeoutMs: 20_000 },
        )
      } finally {
        watcher.stop()
      }
      captured = watcher.captured
    }

    expect(lastResult?.ok, lastResult?.error).toBe(true)
    expect(Number.isFinite(lastResult?.score?.accuracy)).toBe(true)
    expect(captured.length, 'no /proc/<pid>/environ sample of the evaluator child').toBeGreaterThan(0)

    for (const [name, value] of Object.entries(CANARY_VALUES)) {
      const leaked = captured.filter(environ => environ.includes(value))
      expect(leaked.length, `${name} canary value reached the evaluator child`).toBe(0)
    }
  })
})

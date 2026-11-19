import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertValidEvolutionBudget } from '../src/evolution/budget-validate.ts'
import { defaultBaselineStrategy } from '../src/evolution/dataset.ts'
import { isolatedEvaluateSplit } from '../src/evolution/isolate-eval.ts'
import type { EvolutionEvalCase } from '../src/evolution/types.ts'

const tempDirs: string[] = []

function makeWorkDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-eval-output-limit-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

// Same tiny fixture as the repro: the default strategy scores this 1/1, and the
// trusted child's JSON line is far longer than a 16-byte cap.
const cases: EvolutionEvalCase[] = [
  { id: 'tr-1', speculative: true, report: { kind: 'ready', text: 'ready fixed reproduced' }, expected: 'deliver' },
]

function pidsReferencing(fragment: string): number[] {
  if (process.platform !== 'linux') return []
  const pids: number[] = []
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8')
      if (cmdline.includes(fragment)) pids.push(Number(entry))
    } catch {
      // The process vanished while we were reading it.
    }
  }
  return pids
}

async function waitUntilNoProcess(fragment: string, timeoutMs = 5_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const pids = pidsReferencing(fragment)
    if (pids.length === 0 || Date.now() > deadline) return pids
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

describe('isolated evaluator output cap', () => {
  it('refuses a child whose output exceeds maxOutputBytes and leaves no child running', async () => {
    const workDir = makeWorkDir()
    const result = await isolatedEvaluateSplit(
      workDir,
      defaultBaselineStrategy(),
      'train',
      cases,
      { evalTimeoutMs: 20_000, maxOutputBytes: 16 },
    )

    expect(result.ok, JSON.stringify(result)).toBe(false)
    expect(result.error).toContain('eval_output_limit')
    expect(result.score).toBeUndefined()
    expect(result.timedOut).not.toBe(true)

    if (process.platform === 'linux') {
      const lingering = await waitUntilNoProcess(workDir)
      expect(lingering).toEqual([])
    }
  })

  it('still scores with the default and an explicit generous cap', async () => {
    const defaultResult = await isolatedEvaluateSplit(
      makeWorkDir(),
      defaultBaselineStrategy(),
      'train',
      cases,
      { evalTimeoutMs: 20_000 },
    )
    expect(defaultResult.ok, defaultResult.error).toBe(true)
    expect(Number.isFinite(defaultResult.score?.accuracy)).toBe(true)
    expect(defaultResult.score?.accuracy).toBe(1)

    const generousResult = await isolatedEvaluateSplit(
      makeWorkDir(),
      defaultBaselineStrategy(),
      'train',
      cases,
      { evalTimeoutMs: 20_000, maxOutputBytes: 65_536 },
    )
    expect(generousResult.ok, generousResult.error).toBe(true)
    expect(Number.isFinite(generousResult.score?.accuracy)).toBe(true)
    expect(generousResult.score?.accuracy).toBe(1)
  })
})

describe('maxOutputBytes budget validation', () => {
  it('rejects zero and accepts a positive integer', () => {
    expect(() => assertValidEvolutionBudget({ maxOutputBytes: 0 })).toThrow(/maxOutputBytes/)
    expect(() => assertValidEvolutionBudget({ maxOutputBytes: 1 })).not.toThrow()
    expect(() => assertValidEvolutionBudget({ maxOutputBytes: 65_536 })).not.toThrow()
  })
})

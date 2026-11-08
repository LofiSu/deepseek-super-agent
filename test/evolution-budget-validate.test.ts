import { afterEach, describe, expect, it } from 'vitest'
import { assertValidEvolutionBudget } from '../src/evolution/budget-validate.ts'
import { reserveFinalTestUnits } from '../src/evolution/budget-ledger.ts'
import { createExperiment } from '../src/evolution/experiment.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const homes: string[] = []
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true })
})

describe('budget validation fail-closed', () => {
  it('rejects NaN and negative budgets', () => {
    expect(() => assertValidEvolutionBudget({ maxEvals: NaN })).toThrow(/invalid maxEvals/)
    expect(() => assertValidEvolutionBudget({ maxCandidates: 0 })).toThrow(/maxCandidates/)
    expect(() => assertValidEvolutionBudget({ reserveEvals: 99, maxEvals: 8 })).toThrow(/reserveEvals/)
    expect(() => assertValidEvolutionBudget({ evalTimeoutMs: 0 })).toThrow(/evalTimeoutMs/)
  })

  it('final test reserve fails when reserveEvals < EVAL_CALLS_FINALTEST', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-ft-budget-'))
    homes.push(home)
    createExperiment({
      home,
      datasetDigest: 'd',
      evaluatorDigest: 'e',
      seed: 1,
      budget: { maxCandidates: 2, maxEvals: 10, evalTimeoutMs: 5000, reserveEvals: 1 },
    })
    expect(() => reserveFinalTestUnits(home)).toThrow(/final test reserve pool/)
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { assertValidEvolutionBudget } from '../src/evolution/budget-validate.ts'
import { EVAL_CALLS_FINALTEST, reserveFinalTestUnits } from '../src/evolution/budget-ledger.ts'
import { createExperiment, experimentPath, mutateExperiment } from '../src/evolution/experiment.ts'
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

  it('rejects a reserveEvals that cannot fund the final test', () => {
    expect(() => assertValidEvolutionBudget({ reserveEvals: 0, maxEvals: 10 })).toThrow(
      /reserveEvals must be >= 2/,
    )
    expect(() => assertValidEvolutionBudget({ reserveEvals: 1, maxEvals: 10 })).toThrow(
      /reserveEvals must be >= 2/,
    )
    expect(() => assertValidEvolutionBudget({ reserveEvals: EVAL_CALLS_FINALTEST - 1 })).toThrow(
      /reserveEvals must be >= 2/,
    )
    // The minimum and the default-sized reserve still pass.
    expect(() => assertValidEvolutionBudget({ reserveEvals: EVAL_CALLS_FINALTEST, maxEvals: 10 })).not.toThrow()
    expect(() => assertValidEvolutionBudget({ reserveEvals: 8, maxEvals: 10 })).not.toThrow()
    // An omitted reserveEvals keeps its later default; it is not treated as 0.
    expect(() => assertValidEvolutionBudget({ maxEvals: 10 })).not.toThrow()
    expect(() => assertValidEvolutionBudget({})).not.toThrow()
  })

  it('createExperiment refuses a budget that cannot fund the final test', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-ft-budget-'))
    homes.push(home)
    expect(() =>
      createExperiment({
        home,
        datasetDigest: 'd',
        evaluatorDigest: 'e',
        seed: 1,
        budget: { maxCandidates: 2, maxEvals: 10, evalTimeoutMs: 5000, reserveEvals: 1 },
      }),
    ).toThrow(/reserveEvals must be >= 2/)
    expect(fs.existsSync(experimentPath(home))).toBe(false)
  })

  it('final test reserve still fails when the persisted reserve pool is too small', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-ft-budget-'))
    homes.push(home)
    createExperiment({
      home,
      datasetDigest: 'd',
      evaluatorDigest: 'e',
      seed: 1,
      budget: { maxCandidates: 2, maxEvals: 10, evalTimeoutMs: 5000, reserveEvals: EVAL_CALLS_FINALTEST },
    })
    // Simulate a legacy persisted experiment whose reserve pool cannot fund the
    // final test: creation/validation now refuse this, but the ledger guard is
    // still the last line of defence.
    mutateExperiment(home, state => {
      state.budget.reserveEvals = EVAL_CALLS_FINALTEST - 1
    })
    expect(() => reserveFinalTestUnits(home)).toThrow(/final test reserve pool/)
  })
})

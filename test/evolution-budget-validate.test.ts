import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { assertValidEvolutionBudget } from '../src/evolution/budget-validate.ts'
import { EVAL_CALLS_FINALTEST, reserveFinalTestUnits } from '../src/evolution/budget-ledger.ts'
import { runEvolution } from '../src/evolution/evolve.ts'
import { createExperiment, experimentPath, mutateExperiment } from '../src/evolution/experiment.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const datasetRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/evolution')

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
    // The minimum and the default-sized reserve still pass when the baseline
    // search reservation also fits in the search pool.
    expect(() => assertValidEvolutionBudget({ reserveEvals: EVAL_CALLS_FINALTEST, maxEvals: 10 })).not.toThrow()
    expect(() => assertValidEvolutionBudget({ reserveEvals: 8, maxEvals: 10 })).not.toThrow()
    expect(() => assertValidEvolutionBudget({ reserveEvals: 2, maxEvals: 10 })).not.toThrow()
    // Omitted values use the same defaults as experiment creation.
    expect(() => assertValidEvolutionBudget({ maxEvals: 10 })).not.toThrow()
    expect(() => assertValidEvolutionBudget({})).not.toThrow()
  })

  it('rejects budgets whose search pool cannot fund baseline search', () => {
    expect(() => assertValidEvolutionBudget({ maxEvals: 8, reserveEvals: 8 })).toThrow(/search pool/)
    expect(() => assertValidEvolutionBudget({ maxEvals: 9, reserveEvals: 8 })).toThrow(/search pool/)
    expect(() => assertValidEvolutionBudget({ maxEvals: 8 })).toThrow(/search pool/)
    expect(() => assertValidEvolutionBudget({ maxEvals: 4 })).toThrow(/reserveEvals exceeds maxEvals/)
  })

  it('createExperiment refuses budgets that cannot fund baseline search without persisting them', () => {
    for (const budget of [
      { maxEvals: 8, reserveEvals: 8 },
      { maxEvals: 9, reserveEvals: 8 },
      { maxEvals: 4 },
    ]) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-baseline-budget-'))
      homes.push(home)
      expect(() =>
        createExperiment({ home, datasetDigest: 'd', evaluatorDigest: 'e', seed: 1, budget }),
      ).toThrow()
      expect(fs.existsSync(experimentPath(home))).toBe(false)
    }
  })

  it('rejects a doomed run before creation and allows a valid retry on the same home', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-baseline-budget-'))
    homes.push(home)
    await expect(runEvolution({
      home,
      datasetRoot,
      budget: { maxCandidates: 8, maxEvals: 8, evalTimeoutMs: 20_000, reserveEvals: 8 },
    })).rejects.toThrow(/search pool/)
    expect(fs.existsSync(experimentPath(home))).toBe(false)

    await expect(runEvolution({
      home,
      datasetRoot,
      budget: { maxCandidates: 1, maxEvals: 64, evalTimeoutMs: 20_000, reserveEvals: 8 },
      stopOnFirstSuccess: true,
    })).resolves.toBeDefined()
    expect(fs.existsSync(experimentPath(home))).toBe(true)
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

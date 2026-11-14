import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeSynthDataset } from '../src/evolution/synth-fixture.ts'
import { runEvolution } from '../src/evolution/evolve.ts'
import { loadExperiment } from '../src/evolution/experiment.ts'
import { acquireSearchRunLock, releaseSearchRunLock } from '../src/evolution/search-run-lock.ts'

function klTrialsFromState(home: string): number {
  const exp = loadExperiment(home)!
  return exp.klArms.reduce((sum, arm) => sum + arm.observations.filter(o => !o.skip).length, 0)
}

const homes: string[] = []
const datasets: string[] = []

afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true })
  for (const d of datasets.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('experiment persistence (E2E counters)', () => {
  const budget = {
    maxCandidates: 6,
    maxEvals: 40,
    evalTimeoutMs: 20_000,
    reserveEvals: 4,
    maxCandidatesThisRun: 1,
  }

  it('after two rounds totalCandidatesGenerated>=2 and totalOpportunities>=2', async () => {
    const datasetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-persist-ds-'))
    datasets.push(datasetRoot)
    writeSynthDataset(datasetRoot)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-persist-home-'))
    homes.push(home)

    await runEvolution({
      home,
      datasetRoot,
      selector: 'simplified-greedy',
      stopOnFirstSuccess: false,
      budget,
    })
    await runEvolution({
      home,
      datasetRoot,
      round: 2,
      selector: 'policy-memory',
      budget,
    })

    const exp = loadExperiment(home)!
    expect(exp.totalCandidatesGenerated).toBeGreaterThanOrEqual(2)
    expect(exp.totalOpportunities).toBeGreaterThanOrEqual(2)
    const searchReservations = (exp.budget.reservations ?? [])
      .filter(r => !r.reason.startsWith('finaltest_'))
    const searchUsed = searchReservations.reduce((a, r) => a + r.units, 0)
    expect(searchUsed).toBeGreaterThanOrEqual(2 + 2 * exp.totalCandidatesGenerated)
    expect(exp.budget.childEvalLaunches).toBeGreaterThanOrEqual(2 * exp.totalCandidatesGenerated)
  })

  it('maxCandidates=2 blocks a third generation despite high eval budget', async () => {
    const datasetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-cap-ds-'))
    datasets.push(datasetRoot)
    writeSynthDataset(datasetRoot)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-cap-home-'))
    homes.push(home)
    const tight = { maxCandidates: 2, maxEvals: 80, evalTimeoutMs: 15_000, reserveEvals: 4, maxCandidatesThisRun: 3 }

    await runEvolution({
      home,
      datasetRoot,
      selector: 'simplified-greedy',
      stopOnFirstSuccess: false,
      budget: tight,
    })
    const mid = loadExperiment(home)!
    // A single run may now emit more than one distinct direction (remaining-token
    // fallback). The experiment cap still forbids exceeding maxCandidates.
    expect(mid.totalCandidatesGenerated).toBeGreaterThanOrEqual(1)
    expect(mid.totalCandidatesGenerated).toBeLessThanOrEqual(2)

    await runEvolution({
      home,
      datasetRoot,
      round: 2,
      selector: 'policy-memory',
      stopOnFirstSuccess: false,
      budget: tight,
    })
    const exp = loadExperiment(home)!
    expect(exp.totalCandidatesGenerated).toBe(2)

    const third = await runEvolution({
      home,
      datasetRoot,
      round: 3,
      selector: 'simplified-greedy',
      stopOnFirstSuccess: false,
      budget: tight,
    })
    expect(third.candidates.filter(c => c.status !== 'rejected_duplicate' && c.status !== 'skipped_invalid').length).toBe(0)
    expect(loadExperiment(home)!.totalCandidatesGenerated).toBe(2)
  })

  it('KL observations persisted and trial count <= totalOpportunities', async () => {
    const datasetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-kl-ds-'))
    datasets.push(datasetRoot)
    writeSynthDataset(datasetRoot)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-kl-home-'))
    homes.push(home)

    await runEvolution({
      home,
      datasetRoot,
      selector: 'kl-ucb',
      stopOnFirstSuccess: false,
      budget: { ...budget, maxCandidatesThisRun: 2 },
    })
    const exp = loadExperiment(home)!
    expect(exp.totalOpportunities).toBeGreaterThanOrEqual(1)
    expect(klTrialsFromState(home)).toBeLessThanOrEqual(exp.totalOpportunities)
  })
})

describe('concurrent search lock', () => {
  it('fails closed when search run lock already held', async () => {
    const datasetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-lock-ds-'))
    datasets.push(datasetRoot)
    writeSynthDataset(datasetRoot)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-lock-home-'))
    homes.push(home)
    const lock = acquireSearchRunLock(home)
    await expect(runEvolution({
      home,
      datasetRoot,
      selector: 'simplified-greedy',
      budget: { maxCandidates: 2, maxEvals: 20, evalTimeoutMs: 10_000, reserveEvals: 4, maxCandidatesThisRun: 1 },
    })).rejects.toThrow(/search run lock/)
    releaseSearchRunLock(home, lock.lockToken)
  })
})

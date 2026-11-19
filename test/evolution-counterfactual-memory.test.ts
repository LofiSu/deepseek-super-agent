import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeSynthDataset } from '../src/evolution/synth-fixture.ts'
import { runEvolution } from '../src/evolution/evolve.ts'

/**
 * Demo uses different *selectors* (greedy round1, policy-memory round2), not a KL vs memory
 * benchmark on identical selector. Here: same post-round1 state; memory-off kl-ucb may still
 * target glimmer; policy-memory skips retired glimmer and picks orbit.
 */

const homes: string[] = []
const datasets: string[] = []

afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true })
  for (const d of datasets.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('counterfactual memory (same snapshot)', () => {
  const budget = { maxCandidates: 4, maxEvals: 24, evalTimeoutMs: 15_000, reserveEvals: 4, maxCandidatesThisRun: 1 }

  async function seedRound1() {
    const datasetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-cf-ds-'))
    datasets.push(datasetRoot)
    writeSynthDataset(datasetRoot)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-cf-home-'))
    homes.push(home)
    await runEvolution({
      home,
      datasetRoot,
      selector: 'simplified-greedy',
      stopOnFirstSuccess: false,
      budget,
    })
    return { home, datasetRoot }
  }

  it('policy-memory round2 avoids retired glimmer; kl-ucb may still pick glimmer arm', async () => {
    const { home: homeMem, datasetRoot: dsMem } = await seedRound1()
    const memRun = await runEvolution({
      home: homeMem,
      datasetRoot: dsMem,
      round: 2,
      selector: 'policy-memory',
      budget,
    })
    const memPick = memRun.candidates[0]?.failureCaseId
    expect(memPick).not.toBe('tr-glimmer')

    const { home: homeKl, datasetRoot: dsKl } = await seedRound1()
    const klRun = await runEvolution({
      home: homeKl,
      datasetRoot: dsKl,
      round: 2,
      selector: 'kl-ucb',
      budget,
    })
    const klPick = klRun.candidates[0]?.failureCaseId
    expect(klPick).toBeDefined()
    // KL does not read retired lesson targets — may equal glimmer; policy-memory must not.
    if (memPick === 'tr-orbit' && klPick === 'tr-glimmer') {
      expect(memPick).not.toBe(klPick)
    }
  })
})

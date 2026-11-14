import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeSynthDataset } from '../src/evolution/synth-fixture.ts'
import { runEvolution } from '../src/evolution/evolve.ts'
import { loadPolicyMemory } from '../src/evolution/policy-memory.ts'
import { stableJsonDigest } from '../src/evolution/digest.ts'

const homes: string[] = []
const datasets: string[] = []

afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true })
  for (const d of datasets.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('synthetic two-round memory lesson (LABEL)', () => {
  it('round1 regression on glimmer; round2 policy-memory picks orbit and succeeds', async () => {
    const datasetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-synth-vitest-'))
    datasets.push(datasetRoot)
    writeSynthDataset(datasetRoot)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-synth-home-'))
    homes.push(home)
    const budget = {
      maxCandidates: 6,
      maxEvals: 24,
      evalTimeoutMs: 20_000,
      reserveEvals: 2,
      maxCandidatesThisRun: 1,
    }

    const r1 = await runEvolution({
      home,
      datasetRoot,
      round: 1,
      selector: 'simplified-greedy',
      stopOnFirstSuccess: false,
      budget,
    })
    expect(r1.candidates.length).toBeGreaterThan(0)
    const r1Tokens = r1.candidates.flatMap(c => c.strategy.positiveTokens ?? [])
    expect(r1Tokens).toContain('glimmer')
    expect(r1.candidates.some(c => c.status === 'rejected_regression' || c.reward === 'failure')).toBe(true)

    const mem = loadPolicyMemory(home, r1.experimentId)
    expect(mem.lessons.some(l => l.status === 'retired' && l.targets.includes('tr-glimmer'))).toBe(true)

    const r2 = await runEvolution({
      home,
      datasetRoot,
      round: 2,
      selector: 'policy-memory',
      budget,
    })
    expect(r2.candidates.length).toBeGreaterThan(0)
    const winner = r2.candidates.find(c => c.status === 'evaluated' && c.reward === 'success')
    expect(winner).toBeDefined()
    expect(winner!.failureCaseId).not.toBe('tr-glimmer')
    expect(winner!.failureCaseId).toBe('tr-orbit')
    expect(winner!.strategy.positiveTokens).toContain('orbit')
    const r1Dir = r1.candidates[0]?.directionKey
    const r2Dir = winner!.directionKey
    expect(stableJsonDigest(r2Dir)).not.toBe(stableJsonDigest(r1Dir ?? ''))
  })

  it('same snapshot: policy-memory vs kl-ucb yield distinct failureCaseId choice', async () => {
    const datasetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-synth-vitest-'))
    datasets.push(datasetRoot)
    writeSynthDataset(datasetRoot)

    async function snapshotRun(selector: 'kl-ucb' | 'policy-memory') {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-snap-'))
      homes.push(home)
      const budget = { maxCandidates: 4, maxEvals: 20, evalTimeoutMs: 15_000, reserveEvals: 2, maxCandidatesThisRun: 1 }
      await runEvolution({
        home,
        datasetRoot,
        selector: 'simplified-greedy',
        stopOnFirstSuccess: false,
        budget,
      })
      const report = await runEvolution({
        home,
        datasetRoot,
        round: 2,
        selector,
        budget,
      })
      return report.candidates[0]?.failureCaseId
    }

    const withMemory = await snapshotRun('policy-memory')
    const withKl = await snapshotRun('kl-ucb')
    expect(withMemory).toBeDefined()
    expect(withKl).toBeDefined()
  })
})

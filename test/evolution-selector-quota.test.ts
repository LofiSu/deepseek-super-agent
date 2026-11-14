import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { selectArmId, NEW_DIRECTION_QUOTA_PER_RUN } from '../src/evolution/search-selector.ts'
import { emptyCarrier } from '../src/evolution/policy-memory.ts'
import { writeSynthDataset } from '../src/evolution/synth-fixture.ts'
import { runEvolution } from '../src/evolution/evolve.ts'

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temps.push(dir)
  return dir
}

const failures = [
  { id: 'tr-a', speculative: true, report: { kind: 'x', text: 'a' }, expected: 'deliver' as const },
  { id: 'tr-b', speculative: true, report: { kind: 'x', text: 'b' }, expected: 'deliver' as const },
]

const arms = failures.map(f => ({ id: `fail_${f.id}`, observations: [] as { id: string; reward: 0 | 1; skip?: boolean }[] }))

describe('per-run novel direction quota', () => {
  it('kl_ucb reserves cold arm while novel quota unmet', () => {
    const tried = [
      { id: 'fail_tr-a', observations: [{ id: 'o1', reward: 0 as const }] },
      { id: 'fail_tr-b', observations: [] as { id: string; reward: 0 | 1; skip?: boolean }[] },
    ]
    const pick = selectArmId({
      mode: 'kl-ucb',
      arms: tried,
      trainFailures: failures,
      memory: emptyCarrier('e', 1),
      seenDirections: new Set(['seen']),
      retiredFailureIds: new Set(),
      totalOpportunities: 5,
      roundNovelAttempted: 0,
      novelQuota: NEW_DIRECTION_QUOTA_PER_RUN,
      seed: 42,
      discoverMinColdArms: 2,
    })
    expect(pick.armId).toBe('fail_tr-b')
    expect(pick.selectionReason).toMatch(/novel_quota/)
  })

  it('reports no viable arms under policy_memory when all retired', () => {
    const pick = selectArmId({
      mode: 'policy-memory',
      arms,
      trainFailures: failures,
      memory: {
        ...emptyCarrier('e', 1),
        lessons: [{
          id: 'l',
          appliesWhen: 'x',
          mechanismHypothesis: 'x',
          recommendedChange: 'x',
          targets: ['tr-a', 'tr-b'],
          sources: ['c'],
          status: 'retired',
        }],
      },
      seenDirections: new Set(),
      retiredFailureIds: new Set(['tr-a', 'tr-b']),
      totalOpportunities: 1,
      roundNovelAttempted: 0,
      novelQuota: 1,
      seed: 1,
      discoverMinColdArms: 2,
    })
    expect(pick.failureCaseId).toBe('none')
    expect(pick.selectionReason).toContain('no viable')
  })
})

describe('simplified-greedy round-robin across failure arms', () => {
  const rotationFailures = ['tr-a', 'tr-b', 'tr-c'].map(id => ({
    id,
    speculative: true,
    report: { kind: 'x', text: id },
    expected: 'deliver' as const,
  }))
  const rotationArms = rotationFailures.map(f => ({
    id: `fail_${f.id}`,
    observations: [] as { id: string; reward: 0 | 1; skip?: boolean }[],
  }))

  function greedyPick(totalOpportunities: number, armList = rotationArms) {
    return selectArmId({
      mode: 'simplified-greedy',
      arms: armList,
      trainFailures: rotationFailures,
      memory: emptyCarrier('e', 1),
      seenDirections: new Set(),
      retiredFailureIds: new Set(),
      totalOpportunities,
      roundNovelAttempted: 0,
      novelQuota: NEW_DIRECTION_QUOTA_PER_RUN,
      seed: 42,
      discoverMinColdArms: 2,
    })
  }

  it('maps opportunity 1 to the first failure and rotates in order', () => {
    const picks = [1, 2, 3, 4, 5, 6].map(opportunity => greedyPick(opportunity).failureCaseId)
    expect(picks).toEqual(['tr-a', 'tr-b', 'tr-c', 'tr-a', 'tr-b', 'tr-c'])
  })

  it('guards non-positive opportunities instead of indexing arms[-1]', () => {
    expect(greedyPick(0).failureCaseId).toBe('tr-a')
    expect(greedyPick(-1).failureCaseId).toBe('tr-a')
  })

  it('falls back to the first failure only when no arms were materialized', () => {
    expect(greedyPick(2, []).failureCaseId).toBe('tr-a')
  })

  it('runEvolution rotates across synth train failures, starting at the first', async () => {
    const datasetRoot = tempDir('evo-greedy-rotation-ds-')
    writeSynthDataset(datasetRoot)
    const home = tempDir('evo-greedy-rotation-home-')
    const report = await runEvolution({
      home,
      datasetRoot,
      selector: 'simplified-greedy',
      stopOnFirstSuccess: false,
      budget: {
        maxCandidates: 6,
        maxEvals: 30,
        evalTimeoutMs: 20_000,
        reserveEvals: 2,
        maxCandidatesThisRun: 3,
      },
    })
    const ids = report.candidates.map(candidate => candidate.failureCaseId)
    expect(ids[0]).toBe('tr-glimmer')
    const distinctSynthFailures = new Set(
      ids.filter(id => id === 'tr-glimmer' || id === 'tr-orbit' || id === 'tr-neutral'),
    )
    expect(distinctSynthFailures.size).toBeGreaterThan(1)
  })
})

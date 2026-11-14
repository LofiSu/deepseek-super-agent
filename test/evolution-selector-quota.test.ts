import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { selectArmId, NEW_DIRECTION_QUOTA_PER_RUN } from '../src/evolution/search-selector.ts'
import { emptyCarrier } from '../src/evolution/policy-memory.ts'
import { writeSynthDataset } from '../src/evolution/synth-fixture.ts'
import { runEvolution } from '../src/evolution/evolve.ts'
import { sha256File } from '../src/evolution/digest.ts'
import { loadExperiment } from '../src/evolution/experiment.ts'

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

function writeNoProposalDataset(targetDir: string, seed: number): void {
  fs.mkdirSync(targetDir, { recursive: true })
  const train = {
    cases: [
      // Too short for TrainFailureProposer.missingTokens -> always returns null.
      { id: 'tr-silent', speculative: true, report: { kind: 'ready', text: 'ok.' }, expected: 'deliver' },
      { id: 'tr-orbit', speculative: true, report: { kind: 'ready', text: 'orbit linkage complete for deploy.' }, expected: 'deliver' },
      { id: 'tr-glimmer', speculative: true, report: { kind: 'ready', text: 'glimmer linkage complete for deploy.' }, expected: 'deliver' },
    ],
  }
  const validation = {
    cases: [
      { id: 'va-keep', speculative: true, report: { kind: 'ready', text: 'fixed and ready to ship.' }, expected: 'deliver' },
    ],
  }
  const finaltest = {
    cases: [
      { id: 'ft-a', speculative: true, report: { kind: 'ready', text: 'orbit fix validated.' }, expected: 'deliver' },
    ],
  }
  const files = { train: 'train.json', validation: 'validation.json', finaltest: 'finaltest.json' } as const
  for (const [split, data] of [['train', train], ['validation', validation], ['finaltest', finaltest]] as const) {
    fs.writeFileSync(path.join(targetDir, files[split]), JSON.stringify(data, null, 2))
  }
  const manifest = {
    schemaVersion: 2,
    domain: 'deliver-gate-v1',
    splits: files,
    splitDigests: {
      train: sha256File(path.join(targetDir, files.train)),
      validation: sha256File(path.join(targetDir, files.validation)),
      finaltest: sha256File(path.join(targetDir, files.finaltest)),
    },
    seed,
  }
  fs.writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
}

describe('kl-ucb no-proposal cold arms', () => {
  it('seed-0 silent-first run still reaches a proposable failure arm', async () => {
    const datasetRoot = tempDir('evo-kl-noproposal-ds-')
    writeNoProposalDataset(datasetRoot, 0)
    const home = tempDir('evo-kl-noproposal-home-')
    const report = await runEvolution({
      home,
      datasetRoot,
      selector: 'kl-ucb',
      stopOnFirstSuccess: false,
      budget: {
        maxCandidates: 6,
        maxEvals: 24,
        evalTimeoutMs: 20_000,
        reserveEvals: 2,
        maxCandidatesThisRun: 6,
      },
    })
    // The silent arm can never propose, so its rows stay skipped_invalid.
    const silentRows = report.candidates.filter(candidate => candidate.failureCaseId === 'tr-silent')
    expect(silentRows.length).toBeGreaterThan(0)
    expect(silentRows.every(candidate => candidate.status === 'skipped_invalid')).toBe(true)
    // The loop must not spend every step on it: a proposable arm is reached.
    const reached = report.candidates.filter(
      candidate =>
        (candidate.failureCaseId === 'tr-orbit' || candidate.failureCaseId === 'tr-glimmer')
        && candidate.status === 'evaluated',
    )
    expect(reached.length).toBeGreaterThan(0)
  })

  it('records a non-skip failure observation for an arm that yields no proposal', async () => {
    const datasetRoot = tempDir('evo-kl-noproposal-ds-')
    writeNoProposalDataset(datasetRoot, 0)
    const home = tempDir('evo-kl-noproposal-home-')
    await runEvolution({
      home,
      datasetRoot,
      selector: 'kl-ucb',
      stopOnFirstSuccess: false,
      budget: {
        maxCandidates: 6,
        maxEvals: 24,
        evalTimeoutMs: 20_000,
        reserveEvals: 2,
        maxCandidatesThisRun: 6,
      },
    })
    const experiment = loadExperiment(home)
    expect(experiment).not.toBeNull()
    const silentArm = experiment!.klArms.find(arm => arm.id === 'fail_tr-silent')
    expect(silentArm).toBeDefined()
    const attempted = silentArm!.observations.filter(observation => !observation.skip)
    expect(attempted.length).toBeGreaterThan(0)
    expect(attempted.every(observation => observation.reward === 0)).toBe(true)
  })
})

describe('policy-memory exhausted arms after no proposal', () => {
  function policyMemoryPick(exhausted: Set<string>) {
    return selectArmId({
      mode: 'policy-memory',
      arms,
      trainFailures: failures,
      memory: emptyCarrier('e', 1),
      seenDirections: new Set(),
      retiredFailureIds: new Set(),
      exhaustedFailureIds: exhausted,
      totalOpportunities: 1,
      roundNovelAttempted: 0,
      novelQuota: NEW_DIRECTION_QUOTA_PER_RUN,
      seed: 1,
      discoverMinColdArms: 2,
    })
  }

  it('skips an exhausted failure and picks the next viable one', () => {
    const pick = policyMemoryPick(new Set(['tr-a']))
    expect(pick.failureCaseId).toBe('tr-b')
  })

  it('returns the none sentinel when every failure is exhausted', () => {
    const pick = policyMemoryPick(new Set(['tr-a', 'tr-b']))
    expect(pick.failureCaseId).toBe('none')
    expect(pick.selectionReason).toContain('no viable')
  })

  it('runEvolution does not spend the loop on a silent first failure', async () => {
    const datasetRoot = tempDir('evo-pm-noproposal-ds-')
    writeNoProposalDataset(datasetRoot, 0)
    const home = tempDir('evo-pm-noproposal-home-')
    const report = await runEvolution({
      home,
      datasetRoot,
      selector: 'policy-memory',
      stopOnFirstSuccess: false,
      budget: {
        maxCandidates: 6,
        maxEvals: 24,
        evalTimeoutMs: 20_000,
        reserveEvals: 2,
        maxCandidatesThisRun: 6,
      },
    })

    // The silent arm is tried once (its null proposal is recorded), then skipped.
    const silentRows = report.candidates.filter(candidate => candidate.failureCaseId === 'tr-silent')
    expect(silentRows).toHaveLength(1)
    expect(silentRows[0]!.status).toBe('skipped_invalid')
    expect(silentRows[0]!.selectionReason).toContain('no_proposal')
    const silentIndex = report.candidates.indexOf(silentRows[0]!)
    const laterSilent = report.candidates
      .slice(silentIndex + 1)
      .filter(candidate => candidate.failureCaseId === 'tr-silent')
    expect(laterSilent).toHaveLength(0)

    // A proposable train failure is reached and evaluated.
    const reached = report.candidates.filter(
      candidate =>
        (candidate.failureCaseId === 'tr-orbit' || candidate.failureCaseId === 'tr-glimmer')
        && candidate.status === 'evaluated',
    )
    expect(reached.length).toBeGreaterThan(0)
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

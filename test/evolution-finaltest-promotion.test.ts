import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runEvolution } from '../src/evolution/evolve.ts'
import { freezeCandidate, loadExperiment } from '../src/evolution/experiment.ts'
import { runFinalTestOnce } from '../src/evolution/finalize.ts'
import { approvePromotion, promotedStrategyPath } from '../src/evolution/promotion.ts'
import { claimConsumedPath, claimLockPath } from '../src/evolution/final-test-claim-lock.ts'
import { sha256File, stableJsonDigest } from '../src/evolution/digest.ts'
import {
  defaultBaselineStrategy,
  loadCommittedFinaltestSplit,
  loadSearchDatasetOnly,
} from '../src/evolution/dataset.ts'
import type { DeliverGateStrategyV1 } from '../src/evolution/types.ts'

const homes: string[] = []
const datasets: string[] = []
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureDatasetRoot = path.join(repoRoot, 'test/fixtures/evolution')

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
  for (const root of datasets.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/**
 * The injection strategy keys on `alpha` / `zeta` / `cannot`. Baseline already
 * classifies the alpha and cannot cases; `zeta` is the train-only token that
 * makes the candidate strictly improve on the train baseline. Every variant
 * still misses the held-out finaltest cases.
 */
function writeFinalTestRegressionDataset(
  targetDir: string,
  firstFinaltestCaseId = 'ft-no-alpha',
): string {
  fs.mkdirSync(targetDir, { recursive: true })
  const train = {
    cases: [
      {
        id: 'tr-alpha',
        speculative: true,
        report: { kind: 'ready', text: 'alpha patch is ready.' },
        expected: 'deliver',
      },
      {
        id: 'tr-cannot',
        speculative: true,
        report: { kind: 'ready', text: 'cannot reproduce the failure.' },
        expected: 'discard',
      },
      {
        id: 'tr-zeta',
        speculative: true,
        report: { kind: 'ready', text: 'zeta queue drained.' },
        expected: 'deliver',
      },
    ],
  }
  const validation = {
    cases: [
      {
        id: 'va-alpha',
        speculative: true,
        report: { kind: 'ready', text: 'alpha fix is ready.' },
        expected: 'deliver',
      },
      {
        id: 'va-cannot',
        speculative: true,
        report: { kind: 'ready', text: 'cannot ship this change.' },
        expected: 'discard',
      },
    ],
  }
  const finaltest = {
    cases: [
      {
        id: firstFinaltestCaseId,
        speculative: true,
        report: { kind: 'ready', text: 'beta patch is ready.' },
        expected: 'deliver',
      },
      {
        id: 'ft-alpha-discard',
        speculative: true,
        report: { kind: 'ready', text: 'alpha noise only; nothing valuable.' },
        expected: 'discard',
      },
    ],
  }
  const trainFile = path.join(targetDir, 'train.json')
  const validationFile = path.join(targetDir, 'validation.json')
  const finaltestFile = path.join(targetDir, 'finaltest.json')
  const manifestFile = path.join(targetDir, 'manifest.json')
  fs.writeFileSync(trainFile, JSON.stringify(train, null, 2))
  fs.writeFileSync(validationFile, JSON.stringify(validation, null, 2))
  fs.writeFileSync(finaltestFile, JSON.stringify(finaltest, null, 2))
  const finaltestDigest = sha256File(finaltestFile)
  const manifest = {
    schemaVersion: 2,
    domain: 'deliver-gate-v1',
    splits: { train: 'train.json', validation: 'validation.json', finaltest: 'finaltest.json' },
    splitDigests: {
      train: sha256File(trainFile),
      validation: sha256File(validationFile),
      finaltest: finaltestDigest,
    },
    seed: 20261113,
  }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
  return stableJsonDigest([
    sha256File(manifestFile),
    sha256File(trainFile),
    sha256File(validationFile),
    finaltestDigest,
  ])
}

function regressionStrategy(): DeliverGateStrategyV1 {
  return {
    schemaVersion: 2,
    domain: 'deliver-gate-v1',
    positiveTokens: ['alpha', 'zeta'],
    negativeTokens: ['cannot'],
    clauseLocalPositive: true,
  }
}

describe('promotion final-test gate', () => {
  it('refuses promotion when the one-shot final test failed', async () => {
    const datasetRoot = tempDir('evo-finaltest-ds-')
    datasets.push(datasetRoot)
    writeFinalTestRegressionDataset(datasetRoot)
    const home = tempDir('evo-finaltest-home-')
    homes.push(home)

    const report = await runEvolution({
      home,
      datasetRoot,
      injectCandidates: [regressionStrategy()],
      budget: { maxCandidates: 1, maxEvals: 10, evalTimeoutMs: 20_000, reserveEvals: 2 },
    })
    const candidate = report.candidates.find(item => item.status === 'evaluated')
    expect(candidate).toBeDefined()
    expect(candidate!.reward).toBe('success')
    expect(candidate!.scores.find(score => score.split === 'validation')?.accuracy).toBe(1)

    freezeCandidate({ home, candidateId: candidate!.candidateId, runId: report.runId })
    const finalTest = await runFinalTestOnce({
      home,
      datasetRoot,
      candidateId: candidate!.candidateId,
    })
    expect(finalTest.scores).toHaveLength(1)
    expect(finalTest.scores[0]?.split).toBe('finaltest')
    expect(finalTest.scores[0]?.total).toBeGreaterThanOrEqual(1)
    expect(finalTest.scores[0]?.accuracy).toBeLessThan(1)

    const artifactPath = path.join(report.archiveDir, candidate!.candidateId, 'candidate.json')
    expect(() => approvePromotion({
      home,
      runReport: report,
      candidateId: candidate!.candidateId,
      artifactPath,
    })).toThrow(/final test gate/i)
    expect(fs.existsSync(promotedStrategyPath(home))).toBe(false)
  })
})

describe('final-test request preconditions do not spend the one-shot claim', () => {
  it('leaves the experiment claimable after a dataset digest mismatch', async () => {
    const datasetRoot = tempDir('evo-finaltest-digest-ds-')
    datasets.push(datasetRoot)
    writeFinalTestRegressionDataset(datasetRoot)
    // Same train/validation bytes, different holdout bytes: only the dataset
    // digest differs, and loadSearchDatasetOnly still succeeds.
    const otherDatasetRoot = tempDir('evo-finaltest-digest-other-ds-')
    datasets.push(otherDatasetRoot)
    writeFinalTestRegressionDataset(otherDatasetRoot, 'ft-other-alpha')
    const home = tempDir('evo-finaltest-digest-home-')
    homes.push(home)

    const report = await runEvolution({
      home,
      datasetRoot,
      injectCandidates: [regressionStrategy()],
      budget: { maxCandidates: 1, maxEvals: 10, evalTimeoutMs: 20_000, reserveEvals: 2 },
    })
    const candidate = report.candidates.find(item => item.status === 'evaluated')
    expect(candidate).toBeDefined()
    expect(candidate!.reward).toBe('success')
    freezeCandidate({ home, candidateId: candidate!.candidateId, runId: report.runId })
    expect(loadExperiment(home)!.phase).toBe('frozen')

    // A wrong --dataset is a request precondition, not a holdout failure: it
    // must not claim, finalize, or write the consumed marker.
    await expect(runFinalTestOnce({
      home,
      datasetRoot: otherDatasetRoot,
      candidateId: candidate!.candidateId,
    })).rejects.toThrow(/dataset digest mismatch vs preregistered experiment/)

    const afterMismatch = loadExperiment(home)!
    expect(afterMismatch.phase).toBe('frozen')
    expect(afterMismatch.finalTestClaim).toBeNull()
    expect(afterMismatch.finalTest).toBeNull()
    expect(fs.existsSync(claimConsumedPath(home))).toBe(false)
    expect(fs.existsSync(claimLockPath(home))).toBe(false)

    // The honest finalize against the preregistered dataset still claims and runs.
    const finalTest = await runFinalTestOnce({
      home,
      datasetRoot,
      candidateId: candidate!.candidateId,
    })
    expect(finalTest.scores).toHaveLength(1)
    const after = loadExperiment(home)!
    expect(after.phase).toBe('finalized')
    expect(after.finalTestClaim?.state).toBe('SUCCEEDED')
    expect(after.finalTest).not.toBeNull()
  })

  it('leaves the experiment claimable after a tampered artifact', async () => {
    const datasetRoot = tempDir('evo-finaltest-artifact-ds-')
    datasets.push(datasetRoot)
    writeFinalTestRegressionDataset(datasetRoot)
    const home = tempDir('evo-finaltest-artifact-home-')
    homes.push(home)

    const report = await runEvolution({
      home,
      datasetRoot,
      injectCandidates: [regressionStrategy()],
      budget: { maxCandidates: 1, maxEvals: 10, evalTimeoutMs: 20_000, reserveEvals: 2 },
    })
    const candidate = report.candidates.find(item => item.status === 'evaluated')
    expect(candidate).toBeDefined()
    freezeCandidate({ home, candidateId: candidate!.candidateId, runId: report.runId })

    const artifactPath = path.join(report.archiveDir, candidate!.candidateId, 'candidate.json')
    const tampered = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
    tampered.strategy.positiveTokens.push('totallynewtoken')
    fs.writeFileSync(artifactPath, JSON.stringify(tampered, null, 2))

    // Artifact loading binds the frozen selection before the claim, so a
    // tampered artifact is rejected without spending the one-shot.
    await expect(runFinalTestOnce({
      home,
      datasetRoot,
      candidateId: candidate!.candidateId,
    })).rejects.toThrow(/artifact full seal mismatch/)

    const after = loadExperiment(home)!
    expect(after.phase).toBe('frozen')
    expect(after.finalTestClaim).toBeNull()
    expect(after.finalTest).toBeNull()
    expect(fs.existsSync(claimConsumedPath(home))).toBe(false)
    expect(fs.existsSync(claimLockPath(home))).toBe(false)
  })
})

describe('finalize loading failure aborts the one-shot claim', () => {
  it('keeps the pre-claim finaltest commitment when manifest changes later', () => {
    const datasetRoot = tempDir('evo-finaltest-commitment-ds-')
    datasets.push(datasetRoot)
    writeFinalTestRegressionDataset(datasetRoot)

    const search = loadSearchDatasetOnly(datasetRoot)
    const replacementPath = path.join(datasetRoot, 'replacement-finaltest.json')
    fs.writeFileSync(replacementPath, JSON.stringify({ cases: [{
      id: 'replacement',
      speculative: true,
      report: { kind: 'ready', text: 'replacement finaltest' },
      expected: 'deliver',
    }] }, null, 2))
    const manifestPath = path.join(datasetRoot, 'manifest.json')
    const changedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    changedManifest.splits.finaltest = 'replacement-finaltest.json'
    changedManifest.splitDigests.finaltest = sha256File(replacementPath)
    fs.writeFileSync(manifestPath, JSON.stringify(changedManifest, null, 2))

    expect(loadCommittedFinaltestSplit(search).map(testCase => testCase.id))
      .toEqual(['ft-no-alpha', 'ft-alpha-discard'])
  })

  it('rejects a malformed finaltest commitment before creating an experiment', async () => {
    const datasetRoot = tempDir('evo-finaltest-bad-commitment-ds-')
    datasets.push(datasetRoot)
    writeFinalTestRegressionDataset(datasetRoot)
    const manifestPath = path.join(datasetRoot, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.splitDigests.finaltest = 'not-a-sha256-commitment'
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    const home = tempDir('evo-finaltest-bad-commitment-home-')
    homes.push(home)

    // The low-level search parser remains useful for tests that intentionally
    // inspect search-only loading, while production admission rejects the
    // missing sealed commitment before creating or mutating experiment state.
    expect(loadSearchDatasetOnly(datasetRoot).finaltestCommitment).toBeUndefined()
    await expect(runEvolution({
      home,
      datasetRoot,
      injectCandidates: [regressionStrategy()],
      budget: { maxCandidates: 1, maxEvals: 10, evalTimeoutMs: 20_000, reserveEvals: 2 },
    })).rejects.toThrow(/preregistered commitment must be a SHA-256 digest/)

    expect(loadExperiment(home)).toBeNull()
    expect(fs.existsSync(claimConsumedPath(home))).toBe(false)
    expect(fs.existsSync(claimLockPath(home))).toBe(false)
  })

  it('rejects manifest and finaltest mutation after registration without spending the claim', async () => {
    const datasetRoot = tempDir('evo-finaltest-mutated-ds-')
    datasets.push(datasetRoot)
    writeFinalTestRegressionDataset(datasetRoot)
    const home = tempDir('evo-finaltest-mutated-home-')
    homes.push(home)

    const report = await runEvolution({
      home,
      datasetRoot,
      injectCandidates: [regressionStrategy()],
      budget: { maxCandidates: 1, maxEvals: 10, evalTimeoutMs: 20_000, reserveEvals: 2 },
    })
    const candidate = report.candidates.find(item => item.status === 'evaluated')
    expect(candidate).toBeDefined()
    freezeCandidate({ home, candidateId: candidate!.candidateId, runId: report.runId })

    const finaltestPath = path.join(datasetRoot, 'finaltest.json')
    const finaltest = JSON.parse(fs.readFileSync(finaltestPath, 'utf8'))
    finaltest.cases[0].expected = 'discard'
    fs.writeFileSync(finaltestPath, JSON.stringify(finaltest, null, 2))
    const manifestPath = path.join(datasetRoot, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.splitDigests.finaltest = sha256File(finaltestPath)
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    await expect(runFinalTestOnce({ home, datasetRoot, candidateId: candidate!.candidateId }))
      .rejects.toThrow(/dataset digest mismatch vs preregistered experiment/)
    const after = loadExperiment(home)!
    expect(after.phase).toBe('frozen')
    expect(after.finalTestClaim).toBeNull()
  })

  it('closes the claim when the holdout split overlaps a search split', async () => {
    // The holdout reuses the train case id `tr-alpha` with different bytes, so
    // search and freeze still succeed (finaltest is never parsed there). Only
    // loadFinaltestSplit, after the claim, rejects the dataset.
    const datasetRoot = tempDir('evo-finaltest-overlap-ds-')
    datasets.push(datasetRoot)
    writeFinalTestRegressionDataset(datasetRoot, 'tr-alpha')
    const home = tempDir('evo-finaltest-overlap-home-')
    homes.push(home)

    const report = await runEvolution({
      home,
      datasetRoot,
      injectCandidates: [regressionStrategy()],
      budget: { maxCandidates: 1, maxEvals: 10, evalTimeoutMs: 20_000, reserveEvals: 2 },
    })
    const candidate = report.candidates.find(item => item.status === 'evaluated')
    expect(candidate).toBeDefined()
    expect(candidate!.reward).toBe('success')
    freezeCandidate({ home, candidateId: candidate!.candidateId, runId: report.runId })
    expect(loadExperiment(home)!.phase).toBe('frozen')

    await expect(runFinalTestOnce({
      home,
      datasetRoot,
      candidateId: candidate!.candidateId,
    })).rejects.toThrow(/finaltest split shares case ids with train/)

    const after = loadExperiment(home)!
    expect(after.finalTestClaim?.state).toBe('FAILED')
    expect(after.phase).toBe('finalized')
    expect(after.finalTest).toBeNull()
    expect(fs.existsSync(claimConsumedPath(home))).toBe(true)

    // The lock and the one-shot claim are spent: the retry is rejected as
    // already finalized/consumed, never as a lock still held by this process.
    let retryError = ''
    try {
      await runFinalTestOnce({ home, datasetRoot, candidateId: candidate!.candidateId })
    } catch (error) {
      retryError = error instanceof Error ? error.message : String(error)
    }
    expect(retryError).toMatch(/finalized|consumed|duplicate|already/i)
    expect(retryError).not.toMatch(/lock held by another process/)
    expect(loadExperiment(home)!.finalTestClaim?.state).toBe('FAILED')
  })

  it('still finalizes an honest disjoint holdout', async () => {
    const datasetRoot = tempDir('evo-finaltest-disjoint-ds-')
    datasets.push(datasetRoot)
    writeFinalTestRegressionDataset(datasetRoot)
    const home = tempDir('evo-finaltest-disjoint-home-')
    homes.push(home)

    const report = await runEvolution({
      home,
      datasetRoot,
      injectCandidates: [regressionStrategy()],
      budget: { maxCandidates: 1, maxEvals: 10, evalTimeoutMs: 20_000, reserveEvals: 2 },
    })
    const candidate = report.candidates.find(item => item.status === 'evaluated')
    expect(candidate).toBeDefined()
    freezeCandidate({ home, candidateId: candidate!.candidateId, runId: report.runId })

    const finalTest = await runFinalTestOnce({
      home,
      datasetRoot,
      candidateId: candidate!.candidateId,
    })
    expect(finalTest.scores).toHaveLength(1)
    const after = loadExperiment(home)!
    expect(after.finalTestClaim?.state).toBe('SUCCEEDED')
    expect(after.phase).toBe('finalized')
    expect(after.finalTest).not.toBeNull()
    expect(fs.existsSync(claimConsumedPath(home))).toBe(true)
  })
})

describe('train-improvement admission gate', () => {
  it('refuses to freeze a candidate that does not beat the train baseline', async () => {
    const home = tempDir('evo-traingate-home-')
    homes.push(home)
    const baseline = defaultBaselineStrategy()
    // An unused positive token: train, validation, and finaltest scores match
    // the baseline exactly, so reward is failure despite validation accuracy 1.
    const noGain: DeliverGateStrategyV1 = {
      ...baseline,
      positiveTokens: [...(baseline.positiveTokens ?? []), 'widget'],
    }

    const report = await runEvolution({
      home,
      datasetRoot: fixtureDatasetRoot,
      injectCandidates: [noGain],
      budget: { maxCandidates: 1, maxEvals: 10, evalTimeoutMs: 20_000, reserveEvals: 2 },
      stopOnFirstSuccess: false,
    })
    const candidate = report.candidates.find(item => item.status === 'evaluated')
    expect(candidate).toBeDefined()
    expect(candidate!.reward).toBe('failure')
    expect(candidate!.scores.find(score => score.split === 'validation')?.accuracy).toBe(1)

    expect(() => freezeCandidate({
      home,
      candidateId: candidate!.candidateId,
      runId: report.runId,
    })).toThrow(/train gate/i)
    expect(loadExperiment(home)!.phase).toBe('search')
    expect(loadExperiment(home)!.finalTest).toBeNull()
    expect(fs.existsSync(promotedStrategyPath(home))).toBe(false)
  })
})

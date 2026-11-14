import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runEvolution } from '../src/evolution/evolve.ts'
import { freezeCandidate, loadExperiment } from '../src/evolution/experiment.ts'
import { runFinalTestOnce } from '../src/evolution/finalize.ts'
import { approvePromotion, promotedStrategyPath } from '../src/evolution/promotion.ts'
import { sha256File, stableJsonDigest } from '../src/evolution/digest.ts'
import { defaultBaselineStrategy } from '../src/evolution/dataset.ts'
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
function writeFinalTestRegressionDataset(targetDir: string): string {
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
        id: 'ft-no-alpha',
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

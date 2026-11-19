import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runEvolution } from '../src/evolution/evolve.ts'
import {
  freezeCandidate,
  loadExperiment,
  loadPersistedRunReport,
  runReceiptPath,
} from '../src/evolution/experiment.ts'
import { runFinalTestOnce } from '../src/evolution/finalize.ts'
import {
  approvePromotion,
  loadPromotedStrategy,
  promotedStrategyPath,
  promotionRecordPath,
  rollbackPromotion,
} from '../src/evolution/promotion.ts'
import { evolutionRunsDir } from '../src/evolution/archive.ts'
import { parseDeliverGateStrategy } from '../src/evolution/strategy-gate.ts'
import { compileBoundedPattern, tokensToBoundedPattern } from '../src/evolution/safe-pattern.ts'
import { defaultBaselineStrategy } from '../src/evolution/dataset.ts'
import { sha256File, stableJsonDigest } from '../src/evolution/digest.ts'
import { computeEvaluatorDigest } from '../src/evolution/evaluator-identity.ts'
import { resolveDeliverGate } from '../src/speculate/resolve-gate.ts'
import type { DeliverGateStrategyV1, EvolutionRunReport } from '../src/evolution/types.ts'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const datasetRoot = path.join(repoRoot, 'test/fixtures/evolution')
const homes: string[] = []
const datasets: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true })
  }
  for (const dataset of datasets.splice(0)) {
    fs.rmSync(dataset, { recursive: true, force: true })
  }
})

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-evo-sec-'))
  homes.push(home)
  return home
}

async function winningPipeline(home: string) {
  const report = await runEvolution({
    home,
    datasetRoot,
    budget: { maxCandidates: 6, maxEvals: 6, evalTimeoutMs: 20_000, reserveEvals: 2 },
  })
  const winner = report.candidates.find(item => item.status === 'evaluated' && item.reward === 'success')
    ?? report.candidates.find(item => item.status === 'evaluated')
  expect(winner).toBeDefined()
  freezeCandidate({ home, candidateId: winner!.candidateId, runId: report.runId, runReport: report })
  await runFinalTestOnce({ home, datasetRoot, candidateId: winner!.candidateId })
  return { report, winner: winner! }
}

/**
 * Train is solved by the injected `orbit` strategy, held-out validation keeps a
 * `glimmer` miss that no candidate token closes, and the finaltest is solved by
 * the same `orbit` token so only the validation gate is at stake.
 */
function writeValidationMissDataset(targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true })
  const train = {
    cases: [
      {
        id: 'tr-orbit',
        speculative: true,
        report: { kind: 'ready', text: 'orbit queue drained.' },
        expected: 'deliver',
      },
      {
        id: 'tr-keep',
        speculative: true,
        report: { kind: 'ready', text: 'cannot ship this change.' },
        expected: 'discard',
      },
    ],
  }
  const validation = {
    cases: [
      {
        id: 'va-glimmer',
        speculative: true,
        report: { kind: 'ready', text: 'glimmer queue drained.' },
        expected: 'deliver',
      },
      {
        id: 'va-keep',
        speculative: true,
        report: { kind: 'ready', text: 'cannot ship this change.' },
        expected: 'discard',
      },
    ],
  }
  const finaltest = {
    cases: [
      {
        id: 'ft-orbit',
        speculative: true,
        report: { kind: 'ready', text: 'orbit queue drained.' },
        expected: 'deliver',
      },
      {
        id: 'ft-keep',
        speculative: true,
        report: { kind: 'ready', text: 'cannot ship this change.' },
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
  fs.writeFileSync(manifestFile, JSON.stringify({
    schemaVersion: 2,
    domain: 'deliver-gate-v1',
    splits: { train: 'train.json', validation: 'validation.json', finaltest: 'finaltest.json' },
    splitDigests: {
      train: sha256File(trainFile),
      validation: sha256File(validationFile),
      finaltest: sha256File(finaltestFile),
    },
    seed: 20261115,
  }, null, 2))
}

function orbitStrategy(): DeliverGateStrategyV1 {
  return {
    schemaVersion: 2,
    domain: 'deliver-gate-v1',
    positiveTokens: ['orbit'],
    negativeTokens: ['cannot'],
    clauseLocalPositive: true,
  }
}

/**
 * Train and validation are solved by `orbit`, but the held-out finaltest keeps
 * a `glimmer` miss so only the final-test gate is at stake.
 */
function writeFinalTestMissDataset(targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true })
  const train = {
    cases: [
      { id: 'tr-orbit', speculative: true, report: { kind: 'ready', text: 'orbit queue drained.' }, expected: 'deliver' },
      { id: 'tr-keep', speculative: true, report: { kind: 'ready', text: 'cannot ship this change.' }, expected: 'discard' },
    ],
  }
  const validation = {
    cases: [
      { id: 'va-orbit', speculative: true, report: { kind: 'ready', text: 'orbit queue drained.' }, expected: 'deliver' },
      { id: 'va-keep', speculative: true, report: { kind: 'ready', text: 'cannot ship this change.' }, expected: 'discard' },
    ],
  }
  const finaltest = {
    cases: [
      { id: 'ft-glimmer', speculative: true, report: { kind: 'ready', text: 'glimmer queue drained.' }, expected: 'deliver' },
      { id: 'ft-keep', speculative: true, report: { kind: 'ready', text: 'cannot ship this change.' }, expected: 'discard' },
    ],
  }
  const trainFile = path.join(targetDir, 'train.json')
  const validationFile = path.join(targetDir, 'validation.json')
  const finaltestFile = path.join(targetDir, 'finaltest.json')
  const manifestFile = path.join(targetDir, 'manifest.json')
  fs.writeFileSync(trainFile, JSON.stringify(train, null, 2))
  fs.writeFileSync(validationFile, JSON.stringify(validation, null, 2))
  fs.writeFileSync(finaltestFile, JSON.stringify(finaltest, null, 2))
  fs.writeFileSync(manifestFile, JSON.stringify({
    schemaVersion: 2,
    domain: 'deliver-gate-v1',
    splits: { train: 'train.json', validation: 'validation.json', finaltest: 'finaltest.json' },
    splitDigests: {
      train: sha256File(trainFile),
      validation: sha256File(validationFile),
      finaltest: sha256File(finaltestFile),
    },
    seed: 20261115,
  }, null, 2))
}

/**
 * Write only the promotion artifacts `approvePromotion` would have produced,
 * leaving `experiment.json` untouched. Used to model the planted-artifact attack.
 */
function plantPromotionArtifacts(
  home: string,
  report: EvolutionRunReport,
  candidateId: string,
): void {
  const experiment = loadExperiment(home)
  expect(experiment?.finalTest).not.toBeNull()
  const candidate = report.candidates.find(item => item.candidateId === candidateId)
  expect(candidate).toBeDefined()
  const strategy = parseDeliverGateStrategy(candidate!.strategy)
  fs.writeFileSync(promotedStrategyPath(home), JSON.stringify(strategy, null, 2))
  fs.writeFileSync(promotionRecordPath(home), JSON.stringify({
    approvedAt: new Date().toISOString(),
    strategyDigest: stableJsonDigest(strategy),
    artifactDigest: candidate!.artifactDigest,
    datasetDigest: experiment!.datasetDigest,
    evaluatorDigest: computeEvaluatorDigest(),
    artifactPath: path.join(report.archiveDir, candidateId, 'candidate.json'),
    runId: report.runId,
    candidateId,
    experimentId: experiment!.experimentId,
    finalTestLedgerId: experiment!.finalTest!.ledgerId,
  }, null, 2))
}

/** Rewrite a split score inside a run report/receipt file. */
function setValidationAccuracy(file: string, candidateId: string, accuracy: number): void {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  const candidate = doc.candidates.find((item: { candidateId: string }) => item.candidateId === candidateId)
  const validation = candidate.scores.find((score: { split: string }) => score.split === 'validation')
  validation.correct = Math.round(validation.total * accuracy)
  validation.accuracy = accuracy
  fs.writeFileSync(file, JSON.stringify(doc, null, 2))
}

describe('evolution security and ABC final test', () => {
  it('rejects unknown strategy keys and catastrophic regex patterns', () => {
    expect(() => parseDeliverGateStrategy({
      schemaVersion: 2,
      domain: 'deliver-gate-v1',
      positiveTokens: ['ok'],
      negativeTokens: ['no'],
      clauseLocalPositive: true,
      evil: true,
    })).toThrow(/unknown strategy key/)
    expect(() => parseDeliverGateStrategy({
      schemaVersion: 2,
      domain: 'deliver-gate-v1',
      positivePattern: '(a+)+$',
      negativePattern: '\\b(?:no)\\b',
      clauseLocalPositive: true,
    })).toThrow()
  })

  it('rejects nested brace quantifiers in legacy patterns', () => {
    const nestedBrace = '\\b(?:(a{1,}){1,}$)\\b'
    expect(() => compileBoundedPattern(nestedBrace)).toThrow()
    expect(() => compileBoundedPattern('\\b(?:a{1,})\\b')).toThrow()
    expect(() => compileBoundedPattern('\\b(?:(a{1,}){1,})\\b')).toThrow()
    expect(() => compileBoundedPattern('\\b(?:a{2,4})\\b')).toThrow()

    expect(() => parseDeliverGateStrategy({
      schemaVersion: 1,
      domain: 'deliver-gate-v1',
      positivePattern: nestedBrace,
      negativePattern: '\\b(?:no)\\b',
      clauseLocalPositive: true,
    })).toThrow()

    const legitimate = tokensToBoundedPattern(['widget', 'relay'])
    expect(compileBoundedPattern(legitimate)).toBeInstanceOf(RegExp)
    expect(compileBoundedPattern(tokensToBoundedPattern(["don't", 'foo-bar', 'two words'])))
      .toBeInstanceOf(RegExp)
    expect(() => parseDeliverGateStrategy({
      schemaVersion: 2,
      domain: 'deliver-gate-v1',
      positiveTokens: ['widget', 'relay'],
      negativeTokens: ['no'],
      clauseLocalPositive: true,
    })).not.toThrow()
  })

  it('rejects second final test and search after finalize', async () => {
    const home = tempHome()
    const { winner } = await winningPipeline(home)
    await expect(runFinalTestOnce({ home, datasetRoot, candidateId: winner.candidateId }))
      .rejects.toThrow(/duplicate|finalized|already/)
    await expect(runEvolution({ home, datasetRoot })).rejects.toThrow(/search refused|finalized/)
  })

  it('rejects promotion without finalized receipt', async () => {
    const home = tempHome()
    const report = await runEvolution({ home, datasetRoot, budget: { maxCandidates: 4, maxEvals: 12, evalTimeoutMs: 15_000, reserveEvals: 2 } })
    const winner = report.candidates.find(item => item.status === 'evaluated')
    expect(winner).toBeDefined()
    expect(() => approvePromotion({
      home,
      runReport: report,
      candidateId: winner!.candidateId,
      artifactPath: path.join(report.archiveDir, winner!.candidateId, 'candidate.json'),
    })).toThrow(/finalized experiment receipt/)
  })

  it('rejects stale tampered artifact on approval', async () => {
    const home = tempHome()
    const { report, winner } = await winningPipeline(home)
    const artifact = path.join(report.archiveDir, winner.candidateId, 'candidate.json')
    const tampered = JSON.parse(fs.readFileSync(artifact, 'utf8'))
    tampered.strategy.positiveTokens.push('totallynewtoken')
    fs.writeFileSync(artifact, JSON.stringify(tampered, null, 2))
    expect(() => approvePromotion({
      home,
      runReport: report,
      candidateId: winner.candidateId,
      artifactPath: artifact,
    })).toThrow(/digest mismatch|tamper/)
  })

  it('rollback clears promoted consumer', async () => {
    const home = tempHome()
    const { report, winner } = await winningPipeline(home)
    const artifact = path.join(report.archiveDir, winner.candidateId, 'candidate.json')
    const prev = process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE
    process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE = '1'
    try {
      approvePromotion({ home, runReport: report, candidateId: winner.candidateId, artifactPath: artifact })
      expect(resolveDeliverGate(home).constructor.name).toBe('ConfigurableDeliverGate')
      rollbackPromotion(home)
      expect(resolveDeliverGate(home).constructor.name).toBe('HeuristicDeliverGate')
    } finally {
      if (prev === undefined) delete process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE
      else process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE = prev
    }
  })

  it('two search rounds differ after policy memory (fixture)', async () => {
    const home = tempHome()
    const roundBudget = { maxCandidates: 3, maxEvals: 12, evalTimeoutMs: 15_000, reserveEvals: 2 }
    const r1 = await runEvolution({ home, datasetRoot, round: 1, budget: roundBudget })
    const r2 = await runEvolution({ home, datasetRoot, round: 2, budget: roundBudget })
    const exp = loadExperiment(home)
    expect(exp?.seenDirections.length).toBeGreaterThanOrEqual(1)
    expect(r2.round).toBeGreaterThanOrEqual(2)
    const baseline = defaultBaselineStrategy()
    expect(r1.candidates.length + r2.candidates.length).toBeGreaterThan(0)
    expect(baseline.positiveTokens?.length).toBeGreaterThan(0)
  })
})

describe('promotion binds to the experiment-sealed frozen receipt', () => {
  it('refuses a swapped run report and receipt that bypass the validation gate', async () => {
    const dataset = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-evo-bind-ds-'))
    datasets.push(dataset)
    writeValidationMissDataset(dataset)
    const home = tempHome()

    const report = await runEvolution({
      home,
      datasetRoot: dataset,
      injectCandidates: [orbitStrategy()],
      budget: { maxCandidates: 1, maxEvals: 10, evalTimeoutMs: 20_000, reserveEvals: 2 },
    })
    const winner = report.candidates.find(item => item.status === 'evaluated')
    expect(winner).toBeDefined()
    expect(winner!.reward).toBe('success')
    expect(winner!.scores.find(score => score.split === 'validation')?.accuracy).toBeLessThan(1)

    freezeCandidate({ home, candidateId: winner!.candidateId, runId: report.runId, runReport: report })
    const finalTest = await runFinalTestOnce({
      home,
      datasetRoot: dataset,
      candidateId: winner!.candidateId,
    })
    expect(finalTest.scores[0]?.accuracy).toBe(1)

    const artifactPath = path.join(report.archiveDir, winner!.candidateId, 'candidate.json')

    // Honest approval refuses on the validation gate and writes nothing.
    expect(() => approvePromotion({
      home,
      runReport: report,
      candidateId: winner!.candidateId,
      artifactPath,
    })).toThrow(/validation gate/)
    expect(fs.existsSync(promotedStrategyPath(home))).toBe(false)
    expect(fs.existsSync(promotionRecordPath(home))).toBe(false)

    // Swap only the replaceable files so validation reads as 1; experiment.json
    // (and its sealed frozenRunReceipt) stays honest.
    for (const file of [
      path.join(evolutionRunsDir(home), `${report.runId}.json`),
      path.join(home, 'evolution', 'frozen-run-receipt.json'),
    ]) {
      const tampered = JSON.parse(fs.readFileSync(file, 'utf8'))
      const candidate = tampered.candidates.find(
        (item: { candidateId: string }) => item.candidateId === winner!.candidateId,
      )
      const validation = candidate.scores.find(
        (score: { split: string }) => score.split === 'validation',
      )
      validation.correct = validation.total
      validation.accuracy = 1
      fs.writeFileSync(file, JSON.stringify(tampered, null, 2))
    }
    const sealedValidation = loadExperiment(home)!.frozenRunReceipt!
      .candidates.find(item => item.candidateId === winner!.candidateId)!
      .scores.find(score => score.split === 'validation')!
    expect(sealedValidation.accuracy).toBeLessThan(1)

    expect(() => approvePromotion({
      home,
      runReport: loadPersistedRunReport(home, report.runId),
      candidateId: winner!.candidateId,
      artifactPath,
    })).toThrow(/sealed frozen receipt|experiment-sealed/i)
    expect(fs.existsSync(promotedStrategyPath(home))).toBe(false)
    expect(fs.existsSync(promotionRecordPath(home))).toBe(false)
  })

  it('still approves an honest fully qualified candidate', async () => {
    const home = tempHome()
    const { report, winner } = await winningPipeline(home)
    const record = approvePromotion({
      home,
      runReport: report,
      candidateId: winner.candidateId,
      artifactPath: path.join(report.archiveDir, winner.candidateId, 'candidate.json'),
    })
    expect(record.candidateId).toBe(winner.candidateId)
    expect(record.experimentId).toBe(loadExperiment(home)!.experimentId)
    expect(loadPromotedStrategy(home)).not.toBeNull()
  })
})

describe('promotion consumer enforces the sealed admission gates', () => {
  function withPromotedGate<T>(fn: () => T): T {
    const prev = process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE
    process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE = '1'
    try {
      return fn()
    } finally {
      if (prev === undefined) delete process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE
      else process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE = prev
    }
  }

  async function searchFreezeFinalize(home: string, dataset: string) {
    const report = await runEvolution({
      home,
      datasetRoot: dataset,
      injectCandidates: [orbitStrategy()],
      budget: { maxCandidates: 1, maxEvals: 10, evalTimeoutMs: 20_000, reserveEvals: 2 },
    })
    const winner = report.candidates.find(item => item.status === 'evaluated')
    expect(winner).toBeDefined()
    expect(winner!.reward).toBe('success')
    freezeCandidate({ home, candidateId: winner!.candidateId, runId: report.runId, runReport: report })
    const finalOut = await runFinalTestOnce({
      home,
      datasetRoot: dataset,
      candidateId: winner!.candidateId,
    })
    return { report, winner: winner!, finalOut }
  }

  it('refuses planted promotion artifacts when sealed validation accuracy is < 1', async () => {
    const dataset = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-evo-consumer-ds-'))
    datasets.push(dataset)
    writeValidationMissDataset(dataset)
    const home = tempHome()
    const { report, winner } = await searchFreezeFinalize(home, dataset)

    expect(winner.scores.find(score => score.split === 'validation')?.accuracy).toBeLessThan(1)
    // Honest approval refuses on the sealed validation gate and writes nothing.
    expect(() => approvePromotion({
      home,
      runReport: report,
      candidateId: winner.candidateId,
      artifactPath: path.join(report.archiveDir, winner.candidateId, 'candidate.json'),
    })).toThrow(/validation gate/)
    expect(fs.existsSync(promotedStrategyPath(home))).toBe(false)
    expect(fs.existsSync(promotionRecordPath(home))).toBe(false)

    // Plant only the artifacts approval would have written. experiment.json stays
    // honest (sealed validation accuracy < 1), so the consumer must refuse.
    plantPromotionArtifacts(home, report, winner.candidateId)

    expect(() => loadPromotedStrategy(home)).toThrow(/validation gate/)
    withPromotedGate(() => {
      expect(() => resolveDeliverGate(home)).toThrow(/validation gate/)
    })
  })

  it('re-applies the gates to the sealed receipt, not a swapped on-disk receipt', async () => {
    const dataset = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-evo-consumer-ds-'))
    datasets.push(dataset)
    writeValidationMissDataset(dataset)
    const home = tempHome()
    const { report, winner } = await searchFreezeFinalize(home, dataset)
    plantPromotionArtifacts(home, report, winner.candidateId)

    // Swap the replaceable on-disk receipt so validation reads as 1; the
    // experiment-sealed receipt still records the honest miss.
    setValidationAccuracy(runReceiptPath(home), winner.candidateId, 1)
    expect(loadExperiment(home)!.frozenRunReceipt!
      .candidates.find(item => item.candidateId === winner.candidateId)!
      .scores.find(score => score.split === 'validation')!.accuracy).toBeLessThan(1)

    expect(() => loadPromotedStrategy(home)).toThrow(/experiment-sealed/)
    withPromotedGate(() => {
      expect(() => resolveDeliverGate(home)).toThrow(/experiment-sealed/)
    })
  })

  it('refuses planted promotion artifacts when sealed final test accuracy is < 1', async () => {
    const dataset = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-evo-consumer-ds-'))
    datasets.push(dataset)
    writeFinalTestMissDataset(dataset)
    const home = tempHome()
    const { report, winner, finalOut } = await searchFreezeFinalize(home, dataset)

    expect(winner.scores.find(score => score.split === 'validation')?.accuracy).toBe(1)
    expect(finalOut.scores.find(score => score.split === 'finaltest')?.accuracy).toBeLessThan(1)
    expect(() => approvePromotion({
      home,
      runReport: report,
      candidateId: winner.candidateId,
      artifactPath: path.join(report.archiveDir, winner.candidateId, 'candidate.json'),
    })).toThrow(/final test gate/)
    expect(fs.existsSync(promotedStrategyPath(home))).toBe(false)
    expect(fs.existsSync(promotionRecordPath(home))).toBe(false)

    plantPromotionArtifacts(home, report, winner.candidateId)

    expect(() => loadPromotedStrategy(home)).toThrow(/final test gate/)
    withPromotedGate(() => {
      expect(() => resolveDeliverGate(home)).toThrow(/final test gate/)
    })
  })
})

describe('freeze binds to the search-recorded run report digest', () => {
  async function searchValidationMiss(home: string, dataset: string) {
    const report = await runEvolution({
      home,
      datasetRoot: dataset,
      injectCandidates: [orbitStrategy()],
      budget: { maxCandidates: 1, maxEvals: 10, evalTimeoutMs: 20_000, reserveEvals: 2 },
    })
    const winner = report.candidates.find(item => item.status === 'evaluated')
    expect(winner).toBeDefined()
    expect(winner!.reward).toBe('success')
    const validation = winner!.scores.find(score => score.split === 'validation')
    expect(validation).toBeDefined()
    expect(validation!.accuracy).toBeLessThan(1)
    return { report, winner: winner!, honestValidation: validation!.accuracy }
  }

  function validationAccuracy(report: EvolutionRunReport, candidateId: string): number | undefined {
    return report.candidates
      .find(item => item.candidateId === candidateId)
      ?.scores.find(score => score.split === 'validation')?.accuracy
  }

  it('refuses to freeze a report swapped on disk after search', async () => {
    const dataset = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-evo-freeze-bind-ds-'))
    datasets.push(dataset)
    writeValidationMissDataset(dataset)
    const home = tempHome()
    const { report, winner, honestValidation } = await searchValidationMiss(home, dataset)

    // Search recorded the honest in-memory report digest, not a disk re-read.
    const before = loadExperiment(home)!
    expect(before.phase).toBe('search')
    expect(before.frozenRunReceipt).toBeNull()
    expect(before.searchRunReceipts).toEqual([
      { runId: report.runId, digest: stableJsonDigest(report) },
    ])

    // Swap only runs/<runId>.json so validation reads as 1. experiment.json is
    // untouched: still in search phase with no sealed receipt.
    const runFile = path.join(evolutionRunsDir(home), `${report.runId}.json`)
    const tampered = JSON.parse(fs.readFileSync(runFile, 'utf8'))
    const candidate = tampered.candidates.find(
      (item: { candidateId: string }) => item.candidateId === winner.candidateId,
    )
    const validation = candidate.scores.find(
      (score: { split: string }) => score.split === 'validation',
    )
    validation.correct = validation.total
    validation.accuracy = 1
    fs.writeFileSync(runFile, JSON.stringify(tampered, null, 2))

    const diskReport = loadPersistedRunReport(home, report.runId)
    expect(validationAccuracy(diskReport, winner.candidateId)).toBe(1)

    expect(() => freezeCandidate({
      home,
      candidateId: winner.candidateId,
      runId: report.runId,
      runReport: diskReport,
    })).toThrow(/recorded search receipt|not recorded by search/)

    const after = loadExperiment(home)!
    expect(after.phase).toBe('search')
    expect(after.frozenRunReceipt).toBeNull()
    expect(after.selectedCandidateId).toBeNull()
    expect(after.searchRunReceipts).toEqual(before.searchRunReceipts)
    expect(validationAccuracy(report, winner.candidateId)).toBe(honestValidation)
    expect(fs.existsSync(path.join(home, 'evolution', 'frozen-run-receipt.json'))).toBe(false)
  })

  it('freezes the untampered search report and seals the real validation score', async () => {
    const dataset = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-evo-freeze-bind-ds-'))
    datasets.push(dataset)
    writeValidationMissDataset(dataset)
    const home = tempHome()
    const { report, winner, honestValidation } = await searchValidationMiss(home, dataset)

    const state = freezeCandidate({
      home,
      candidateId: winner.candidateId,
      runId: report.runId,
    })
    expect(state.phase).toBe('frozen')
    expect(state.frozenRunReceipt).not.toBeNull()
    expect(validationAccuracy(state.frozenRunReceipt!, winner.candidateId))
      .toBe(honestValidation)
  })

  it('still freezes, finalizes, and approves an honest fully qualified candidate', async () => {
    const home = tempHome()
    const { report, winner } = await winningPipeline(home)
    const state = loadExperiment(home)!
    expect(state.phase).toBe('finalized')
    expect(validationAccuracy(state.frozenRunReceipt!, winner.candidateId)).toBe(1)
    const record = approvePromotion({
      home,
      runReport: report,
      candidateId: winner.candidateId,
      artifactPath: path.join(report.archiveDir, winner.candidateId, 'candidate.json'),
    })
    expect(record.candidateId).toBe(winner.candidateId)
    expect(loadPromotedStrategy(home)).not.toBeNull()
  })
})

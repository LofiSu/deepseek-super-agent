import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigurableDeliverGate } from '../src/speculate/configurable-gate.ts'
import { HeuristicDeliverGate } from '../src/speculate/gate.ts'
import { defaultBaselineStrategy } from '../src/evolution/dataset.ts'
import { runEvolution, computeEvaluatorDigestForExport } from '../src/evolution/evolve.ts'
import { TrainFailureProposer } from '../src/evolution/train-proposer.ts'
import { approvePromotion, loadPromotedStrategy, rollbackPromotion } from '../src/evolution/promotion.ts'
import type { DeliverGateStrategyV1 } from '../src/evolution/types.ts'
import { listTrainFailures, scoreCases } from '../src/evolution/score.ts'
import { emptyCarrier } from '../src/evolution/policy-memory.ts'
import { freezeCandidate } from '../src/evolution/experiment.ts'
import { runFinalTestOnce } from '../src/evolution/finalize.ts'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const datasetRoot = path.join(repoRoot, 'test/fixtures/evolution')

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

function tempEvolutionHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-evolution-home-'))
  homes.push(home)
  return home
}

describe('controlled evolution (offline deliver-gate strategy v2)', () => {
  it('baseline fixture scores match train/validation counts (fixture tiny)', () => {
    const baseline = defaultBaselineStrategy()
    const train = JSON.parse(fs.readFileSync(path.join(datasetRoot, 'train.json'), 'utf8')).cases
    const validation = JSON.parse(fs.readFileSync(path.join(datasetRoot, 'validation.json'), 'utf8')).cases
    const finaltest = JSON.parse(fs.readFileSync(path.join(datasetRoot, 'finaltest.json'), 'utf8')).cases
    const trainScore = scoreCases(baseline, 'train', train)
    const valScore = scoreCases(baseline, 'validation', validation)
    const finalScore = scoreCases(baseline, 'finaltest', finaltest)
    expect(trainScore.total).toBe(7)
    expect(valScore.total).toBe(4)
    expect(finalScore.total).toBe(4)
    expect(trainScore.correct).toBeLessThan(trainScore.total)
  })

  it('TrainFailureProposer proposes from train failures (not a static score table)', () => {
    const baseline = defaultBaselineStrategy()
    const train = JSON.parse(fs.readFileSync(path.join(datasetRoot, 'train.json'), 'utf8')).cases
    const failures = listTrainFailures(baseline, train)
    expect(failures.length).toBeGreaterThan(0)
    const proposer = new TrainFailureProposer()
    const next = proposer.propose({
      baseline,
      parentStrategy: baseline,
      trainFailures: failures,
      memory: emptyCarrier('exp', 1),
      seed: 1,
      failureCaseId: failures[0]!.id,
      seenDirections: new Set(),
    })
    expect(next).not.toBeNull()
    expect(next!.positiveTokens).not.toEqual(baseline.positiveTokens)
  })

  it('rejects malformed, duplicate, and regression candidates during search', async () => {
    const home = tempEvolutionHome()
    const baseline = defaultBaselineStrategy()
    const sideways: DeliverGateStrategyV1 = {
      ...baseline,
      positiveTokens: [...baseline.positiveTokens!, 'sideways'],
    }
    const report = await runEvolution({
      home,
      datasetRoot,
      budget: { maxCandidates: 5, maxEvals: 14, evalTimeoutMs: 15_000, reserveEvals: 2 },
      injectCandidates: [
        { ...baseline, positiveTokens: ['neverword'], negativeTokens: baseline.negativeTokens! },
        { ...baseline, positiveTokens: ['!!!invalid'], negativeTokens: baseline.negativeTokens! },
        sideways,
        sideways,
      ],
    })
    expect(report.evaluatorDigest).toBe(computeEvaluatorDigestForExport())
    const statuses = report.candidates.map(item => item.status)
    expect(statuses.some(s => s === 'skipped_invalid' || s === 'rejected_malformed')).toBe(true)
    expect(statuses).toContain('rejected_duplicate')
    expect(statuses.some(s => s === 'rejected_regression' || s === 'evaluated')).toBeTruthy()
  })

  it('end-to-end: search, freeze, finalize, approve, rollback', async () => {
    const home = tempEvolutionHome()
    const report = await runEvolution({
      home,
      datasetRoot,
      budget: { maxCandidates: 6, maxEvals: 6, evalTimeoutMs: 20_000, reserveEvals: 2 },
    })
    const winner = report.candidates.find(item => item.status === 'evaluated' && item.reward === 'success')
      ?? report.candidates.find(item => item.status === 'evaluated')
    expect(winner).toBeDefined()
    expect(winner!.scores.every(score => score.split !== 'finaltest')).toBe(true)

    freezeCandidate({ home, candidateId: winner!.candidateId, runId: report.runId, runReport: report })
    const finalOut = await runFinalTestOnce({ home, datasetRoot, candidateId: winner!.candidateId })
    expect(finalOut.scores[0]?.split).toBe('finaltest')

    const artifact = path.join(report.archiveDir, winner!.candidateId, 'candidate.json')
    const promotion = approvePromotion({
      home,
      runReport: report,
      candidateId: winner!.candidateId,
      artifactPath: artifact,
    })
    expect(promotion.evaluatorDigest).toBe(report.evaluatorDigest)

    const promoted = loadPromotedStrategy(home)
    expect(promoted).not.toBeNull()
    const configurable = new ConfigurableDeliverGate(promoted!)
    const heuristic = new HeuristicDeliverGate()
    const speculative = { speculative: true } as import('../src/shared/types.ts').Ticket
    const train = JSON.parse(fs.readFileSync(path.join(datasetRoot, 'train.json'), 'utf8')).cases
    const fixedCase = train.find((item: { id: string }) => item.id === 'tr-007')
    expect(fixedCase).toBeDefined()
    expect(configurable.evaluate({ ticket: speculative, report: fixedCase.report })).toBe('deliver')
    expect(heuristic.evaluate({ ticket: speculative, report: fixedCase.report })).toBe('discard')

    rollbackPromotion(home)
    expect(loadPromotedStrategy(home)).toBeNull()
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigurableDeliverGate } from '../src/speculate/configurable-gate.ts'
import { HeuristicDeliverGate } from '../src/speculate/gate.ts'
import { defaultBaselineStrategy } from '../src/evolution/dataset.ts'
import { runEvolution, EVALUATOR_DIGEST } from '../src/evolution/evolve.ts'
import { parseDeliverGateStrategy } from '../src/evolution/strategy-gate.ts'
import { TrainFailureProposer, MockFixtureProposer } from '../src/evolution/train-proposer.ts'
import { approvePromotion, loadPromotedStrategy, rollbackPromotion } from '../src/evolution/promotion.ts'
import type { DeliverGateStrategyV1 } from '../src/evolution/types.ts'
import { listTrainFailures, scoreCases } from '../src/evolution/score.ts'
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

describe('controlled evolution (offline deliver-gate strategy v1)', () => {
  it('baseline fixture scores match train/validation/holdout counts', () => {
    const baseline = defaultBaselineStrategy()
    const train = JSON.parse(fs.readFileSync(path.join(datasetRoot, 'train.json'), 'utf8')).cases
    const validation = JSON.parse(fs.readFileSync(path.join(datasetRoot, 'validation.json'), 'utf8')).cases
    const holdout = JSON.parse(fs.readFileSync(path.join(datasetRoot, 'holdout.json'), 'utf8')).cases
    const trainScore = scoreCases(baseline, 'train', train)
    const valScore = scoreCases(baseline, 'validation', validation)
    const hoScore = scoreCases(baseline, 'holdout', holdout)
    expect(trainScore.total).toBe(7)
    expect(valScore.total).toBe(4)
    expect(hoScore.total).toBe(4)
    expect(trainScore.correct).toBeLessThan(trainScore.total)
  })

  it('TrainFailureProposer proposes from train failures (not a static score table)', () => {
    const baseline = defaultBaselineStrategy()
    const train = JSON.parse(fs.readFileSync(path.join(datasetRoot, 'train.json'), 'utf8')).cases
    const failures = listTrainFailures(baseline, train)
    expect(failures.length).toBeGreaterThan(0)
    const proposer = new TrainFailureProposer()
    const next = proposer.propose({ baseline, trainFailures: failures, seed: 1, index: 0 })
    expect(next).not.toBeNull()
    expect(next!.positivePattern).not.toBe(baseline.positivePattern)
  })

  it('rejects malformed, holdout-cheat, and regression candidates', async () => {
    const home = tempEvolutionHome()
    const baseline = defaultBaselineStrategy()
    const holdoutCheat: DeliverGateStrategyV1 = {
      ...baseline,
      positivePattern: baseline.positivePattern.replace(
        /\)\\b$/u,
        "|Valuable fix for checkout.*)\\b",
      ),
    }
    const report = await runEvolution({
      home,
      datasetRoot,
      budget: { maxCandidates: 4, maxEvals: 4, evalTimeoutMs: 15_000 },
      injectCandidates: [
        { ...baseline, positivePattern: '(unclosed' },
        holdoutCheat,
        { ...baseline, positivePattern: 'never-match-anything' },
      ],
    })
    expect(report.evaluatorDigest).toBe(EVALUATOR_DIGEST)
    const statuses = report.candidates.map(item => item.status)
    expect(statuses).toContain('rejected_malformed')
    expect(statuses).toContain('rejected_holdout_cheat')
    expect(statuses).toContain('rejected_regression')
  })

  it('end-to-end: run, approve promoted strategy affects gate, rollback restores default', async () => {
    const home = tempEvolutionHome()
    const report = await runEvolution({
      home,
      datasetRoot,
      budget: { maxCandidates: 6, maxEvals: 6, evalTimeoutMs: 20_000 },
    })
    const winner = report.candidates.find(item => item.status === 'evaluated')
    expect(winner).toBeDefined()
    expect(winner!.scores.some(score => score.split === 'holdout')).toBe(true)

    const artifact = path.join(report.archiveDir, winner!.candidateId, 'candidate.json')
    const promotion = approvePromotion({
      home,
      runReport: report,
      candidateId: winner!.candidateId,
      artifactPath: artifact,
    })
    expect(promotion.strategyDigest).toBe(winner!.strategyDigest)

    const promoted = loadPromotedStrategy(home)
    expect(promoted).not.toBeNull()
    const configurable = new ConfigurableDeliverGate(promoted!)
    const heuristic = new HeuristicDeliverGate()
    const speculative = { speculative: true } as import('../src/shared/types.ts').Ticket
    const train = JSON.parse(fs.readFileSync(path.join(datasetRoot, 'train.json'), 'utf8')).cases
    const fixedCase = train.find((item: { id: string }) => item.id === 'tr-007')
    expect(fixedCase).toBeDefined()
    const cfg = configurable.evaluate({ ticket: speculative, report: fixedCase.report })
    const heu = heuristic.evaluate({ ticket: speculative, report: fixedCase.report })
    expect(cfg).toBe('deliver')
    expect(heu).toBe('discard')

    const rolled = rollbackPromotion(home)
    expect(rolled.rolledBack).toBe(true)
    expect(loadPromotedStrategy(home)).toBeNull()
  })

  it('rejects promotion when artifact digest is tampered', async () => {
    const home = tempEvolutionHome()
    const report = await runEvolution({
      home,
      datasetRoot,
      budget: { maxCandidates: 4, maxEvals: 4, evalTimeoutMs: 20_000 },
    })
    const winner = report.candidates.find(item => item.status === 'evaluated')
    expect(winner).toBeDefined()
    const artifact = path.join(report.archiveDir, winner!.candidateId, 'candidate.json')
    const tampered = JSON.parse(fs.readFileSync(artifact, 'utf8'))
    tampered.strategy.positivePattern = '.*'
    fs.writeFileSync(artifact, JSON.stringify(tampered, null, 2))
    expect(() => approvePromotion({
      home,
      runReport: report,
      candidateId: winner!.candidateId,
      artifactPath: artifact,
    })).toThrow(/digest mismatch/)
  })

  it('MockFixtureProposer adapter interface for deterministic fixture proposals', () => {
    const baseline = defaultBaselineStrategy()
    const variant = parseDeliverGateStrategy({
      ...baseline,
      positivePattern: `${baseline.positivePattern.replace(/\)\\b$/u, '|checkout)')}\\b`,
    })
    const mock = new MockFixtureProposer([variant])
    expect(mock.propose({ baseline, trainFailures: [], seed: 0, index: 0 })).toEqual(variant)
  })
})

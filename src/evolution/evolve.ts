import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { candidateLineageHash, writeCandidateArchive, writeRunReport, evolutionArchiveRoot, evolutionRunsDir } from './archive.ts'
import { defaultBaselineStrategy, loadEvolutionDataset } from './dataset.ts'
import { stableJsonDigest } from './digest.ts'
import { isolatedEvaluateSplit } from './isolate-eval.ts'
import { parseDeliverGateStrategy } from './strategy-gate.ts'
import { EVALUATOR_VERSION, scoreCases } from './score.ts'
import { TrainFailureProposer } from './train-proposer.ts'
import { listTrainFailures } from './score.ts'
import type {
  CandidateProposer,
  DeliverGateStrategyV1,
  EvolutionBudget,
  EvolutionCandidateRecord,
  EvolutionRunReport,
  SplitScore,
} from './types.ts'
import { DEFAULT_EVOLUTION_BUDGET } from './types.ts'

export const EVALUATOR_DIGEST = stableJsonDigest({
  version: EVALUATOR_VERSION,
  domain: 'deliver-gate-v1',
})

function holdoutLeakCheck(strategy: DeliverGateStrategyV1, holdoutTexts: string[]): string | null {
  const blob = JSON.stringify(strategy)
  for (const text of holdoutTexts) {
    if (text.length >= 12 && blob.includes(text.slice(0, 24))) return 'holdout label text embedded in strategy'
  }
  return null
}

async function scoreSplitIsolated(
  workDir: string,
  strategy: DeliverGateStrategyV1,
  split: 'train' | 'validation' | 'holdout',
  cases: import('./types.ts').EvolutionEvalCase[],
  budget: EvolutionBudget,
): Promise<{ scores: SplitScore[]; status: EvolutionCandidateRecord['status']; reason?: string }> {
  const result = await isolatedEvaluateSplit(workDir, strategy, split, cases, budget)
  if (result.timedOut) return { scores: [], status: 'rejected_timeout', reason: 'eval_timeout' }
  if (!result.ok || !result.score) {
    return { scores: [], status: 'rejected_eval_error', reason: result.error ?? 'eval_failed' }
  }
  return { scores: [result.score], status: 'evaluated' }
}

async function evaluateCandidate(
  workDir: string,
  strategy: DeliverGateStrategyV1,
  dataset: ReturnType<typeof loadEvolutionDataset>,
  baselineScores: SplitScore[],
  budget: EvolutionBudget,
): Promise<{ status: EvolutionCandidateRecord['status']; scores: SplitScore[]; reason?: string }> {
  try {
    parseDeliverGateStrategy(strategy)
  } catch (error) {
    return {
      status: 'rejected_malformed',
      scores: [],
      reason: error instanceof Error ? error.message : String(error),
    }
  }
  const leak = holdoutLeakCheck(strategy, dataset.holdout.map(item => item.report.text))
  if (leak) return { status: 'rejected_holdout_cheat', scores: [], reason: leak }

  const scores: SplitScore[] = []
  for (const [split, cases] of [
    ['train', dataset.train],
    ['validation', dataset.validation],
    ['holdout', dataset.holdout],
  ] as const) {
    const part = await scoreSplitIsolated(workDir, strategy, split, cases, budget)
    if (part.status !== 'evaluated') return { status: part.status, scores: [], reason: part.reason }
    scores.push(...part.scores)
  }

  const baseVal = baselineScores.find(item => item.split === 'validation')?.accuracy ?? 0
  const candVal = scores.find(item => item.split === 'validation')?.accuracy ?? 0
  if (candVal + 1e-9 < baseVal) {
    return { status: 'rejected_regression', scores, reason: 'validation worse than baseline' }
  }
  const baseHo = baselineScores.find(item => item.split === 'holdout')?.accuracy ?? 0
  const candHo = scores.find(item => item.split === 'holdout')?.accuracy ?? 0
  if (candHo + 1e-9 < baseHo) {
    return { status: 'rejected_regression', scores, reason: 'holdout worse than baseline' }
  }
  return { status: 'evaluated', scores }
}

export interface EvolveRunInput {
  home: string
  datasetRoot: string
  budget?: EvolutionBudget
  proposer?: CandidateProposer
  /** Injected bad candidates for tests (fixture proposals). */
  injectCandidates?: DeliverGateStrategyV1[]
}

export async function runEvolution(input: EvolveRunInput): Promise<EvolutionRunReport> {
  const budget = input.budget ?? DEFAULT_EVOLUTION_BUDGET
  const dataset = loadEvolutionDataset(input.datasetRoot)
  const baseline = defaultBaselineStrategy()
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-evolution-'))
  const archiveDir = evolutionArchiveRoot(input.home)
  const runsDir = evolutionRunsDir(input.home)
  fs.mkdirSync(archiveDir, { recursive: true })

  const baselineScores: SplitScore[] = []
  for (const [split, cases] of [
    ['train', dataset.train],
    ['validation', dataset.validation],
    ['holdout', dataset.holdout],
  ] as const) {
    const scored = scoreCases(baseline, split, cases)
    baselineScores.push(scored)
  }

  const trainFailures = listTrainFailures(baseline, dataset.train)

  const proposer = input.proposer ?? new TrainFailureProposer()
  const candidates: EvolutionCandidateRecord[] = []
  let evalCount = 0

  const proposeList: (DeliverGateStrategyV1 | null)[] = []
  for (let index = 0; index < budget.maxCandidates; index += 1) {
    if (input.injectCandidates?.[index]) {
      proposeList.push(input.injectCandidates[index]!)
      continue
    }
    proposeList.push(
      proposer.propose({ baseline, trainFailures, seed: dataset.manifest.seed, index }),
    )
  }

  for (let index = 0; index < proposeList.length; index += 1) {
    if (evalCount >= budget.maxEvals) break
    const strategy = proposeList[index]
    if (!strategy) continue
    evalCount += 1
    const strategyDigest = stableJsonDigest(strategy)
    const candidateId = `cand_${index}_${strategyDigest.slice(0, 8)}`
    const parentId = index === 0 ? null : candidates.at(-1)?.candidateId ?? null

    const outcome = await evaluateCandidate(workDir, strategy, dataset, baselineScores, budget)
    const record: EvolutionCandidateRecord = {
      candidateId,
      parentId,
      lineageHash: candidateLineageHash(parentId, strategyDigest),
      strategy,
      strategyDigest,
      status: outcome.status,
      scores: outcome.scores,
      proposedFrom: 'train_failures',
      ...(outcome.reason ? { rejectionReason: outcome.reason } : {}),
      createdAt: new Date().toISOString(),
    }
    const artifactPath = writeCandidateArchive(archiveDir, record)
    void artifactPath
    candidates.push(record)
    if (outcome.status === 'evaluated') {
      const trainScore = outcome.scores.find(item => item.split === 'train')?.accuracy ?? 0
      const baseTrain = baselineScores.find(item => item.split === 'train')?.accuracy ?? 0
      if (trainScore > baseTrain + 1e-9) break
    }
  }

  const report: EvolutionRunReport = {
    schemaVersion: 1,
    domain: dataset.manifest.domain,
    runId: randomUUID(),
    datasetDigest: dataset.datasetDigest,
    evaluatorDigest: EVALUATOR_DIGEST,
    seed: dataset.manifest.seed,
    archiveDir,
    baseline: baselineScores,
    candidates,
    budget,
  }
  writeRunReport(runsDir, report)
  return report
}

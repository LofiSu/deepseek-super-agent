import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { candidateLineageHash, writeCandidateArchive, writeRunReport, evolutionArchiveRoot, evolutionRunsDir } from './archive.ts'
import { defaultBaselineStrategy, loadEvolutionDataset } from './dataset.ts'
import { stableJsonDigest } from './digest.ts'
import { isolatedEvaluateSplit } from './isolate-eval.ts'
import { parseDeliverGateStrategy } from './strategy-gate.ts'
import { scoreCases, listTrainFailures } from './score.ts'
import { TrainFailureProposer } from './train-proposer.ts'
import { computeEvaluatorDigest } from './evaluator-identity.ts'
import {
  assertBudget,
  assertSearchAllowed,
  createExperiment,
  loadExperiment,
  saveExperiment,
} from './experiment.ts'
import { loadPolicyMemory, updatePolicyMemoryFromRound } from './policy-memory.ts'
import { normalizeDirectionKey } from './safe-pattern.ts'
import { klUcbSelect, type KlUcbArm } from './kl-ucb.ts'
import type {
  CandidateProposer,
  DeliverGateStrategyV1,
  EvolutionBudget,
  EvolutionCandidateRecord,
  EvolutionRunReport,
  SplitScore,
} from './types.ts'
import { DEFAULT_EVOLUTION_BUDGET } from './types.ts'

export function computeEvaluatorDigestForExport(): string {
  return computeEvaluatorDigest()
}

async function scoreSplitIsolated(
  workDir: string,
  strategy: DeliverGateStrategyV1,
  split: 'train' | 'validation',
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

async function evaluateCandidateSearch(
  workDir: string,
  strategy: DeliverGateStrategyV1,
  train: import('./types.ts').EvolutionEvalCase[],
  validation: import('./types.ts').EvolutionEvalCase[],
  baselineScores: SplitScore[],
  budget: EvolutionBudget,
  onTimeout: () => void,
  onError: () => void,
): Promise<{ status: EvolutionCandidateRecord['status']; scores: SplitScore[]; reason?: string; reward: EvolutionCandidateRecord['reward'] }> {
  try {
    parseDeliverGateStrategy(strategy)
  } catch (error) {
    return {
      status: 'skipped_invalid',
      scores: [],
      reason: error instanceof Error ? error.message : String(error),
      reward: 'skip',
    }
  }

  const scores: SplitScore[] = []
  for (const [split, cases] of [
    ['train', train],
    ['validation', validation],
  ] as const) {
    const part = await scoreSplitIsolated(workDir, strategy, split, cases, budget)
    if (part.status === 'rejected_timeout') {
      onTimeout()
      return { status: 'rejected_timeout', scores: [], reason: part.reason, reward: 'skip' }
    }
    if (part.status !== 'evaluated') {
      onError()
      return { status: part.status, scores: [], reason: part.reason, reward: 'skip' }
    }
    scores.push(...part.scores)
  }

  const baseVal = baselineScores.find(item => item.split === 'validation')?.accuracy ?? 0
  const candVal = scores.find(item => item.split === 'validation')?.accuracy ?? 0
  if (candVal + 1e-9 < baseVal) {
    return { status: 'rejected_regression', scores, reason: 'validation worse than baseline', reward: 'failure' }
  }
  const baseTrain = baselineScores.find(item => item.split === 'train')?.accuracy ?? 0
  const candTrain = scores.find(item => item.split === 'train')?.accuracy ?? 0
  const reward: EvolutionCandidateRecord['reward'] = candTrain > baseTrain + 1e-9 ? 'success' : 'failure'
  return { status: 'evaluated', scores, reward }
}

export interface EvolveRunInput {
  home: string
  datasetRoot: string
  budget?: EvolutionBudget
  proposer?: CandidateProposer
  injectCandidates?: DeliverGateStrategyV1[]
  selector?: 'kl-ucb' | 'simplified-greedy'
  round?: number
}

export async function runEvolution(input: EvolveRunInput): Promise<EvolutionRunReport> {
  const budget = input.budget ?? DEFAULT_EVOLUTION_BUDGET
  const dataset = loadEvolutionDataset(input.datasetRoot)
  const evaluatorDigest = computeEvaluatorDigest()
  let experiment = loadExperiment(input.home)
  if (!experiment) {
    experiment = createExperiment({
      home: input.home,
      datasetDigest: dataset.datasetDigest,
      evaluatorDigest,
      seed: dataset.manifest.seed,
      budget: {
        maxCandidates: budget.maxCandidates,
        maxEvals: budget.maxEvals,
        evalTimeoutMs: budget.evalTimeoutMs,
        maxOutputBytes: budget.maxOutputBytes ?? 65_536,
        reserveEvals: budget.reserveEvals ?? 8,
        usedEvals: 0,
        errors: 0,
        timeouts: 0,
        providerCalls: 0,
      },
    })
  }
  assertSearchAllowed(experiment)
  if (experiment.datasetDigest !== dataset.datasetDigest) {
    throw new Error('dataset digest mismatch for experiment')
  }
  if (experiment.evaluatorDigest !== evaluatorDigest) {
    throw new Error('evaluator digest mismatch for experiment')
  }

  const round = input.round ?? (experiment.seenDirections.length === 0 ? 1 : experiment.seenDirections.length + 1)
  const baseline = defaultBaselineStrategy()
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-evolution-'))
  const archiveDir = evolutionArchiveRoot(input.home)
  const runsDir = evolutionRunsDir(input.home)
  fs.mkdirSync(archiveDir, { recursive: true })

  const baselineScores: SplitScore[] = []
  for (const [split, cases] of [
    ['train', dataset.train],
    ['validation', dataset.validation],
  ] as const) {
    baselineScores.push(scoreCases(baseline, split, cases))
  }

  const trainFailures = listTrainFailures(baseline, dataset.train)
  const memory = loadPolicyMemory(input.home, experiment.experimentId)
  const proposer = input.proposer ?? new TrainFailureProposer()
  const seenDirections = new Set(experiment.seenDirections)
  const candidates: EvolutionCandidateRecord[] = []
  const selector = input.selector ?? 'kl-ucb'
  const arms: KlUcbArm[] = []

  const proposeList: (DeliverGateStrategyV1 | null)[] = []
  for (let index = 0; index < budget.maxCandidates; index += 1) {
    if (input.injectCandidates?.[index]) {
      proposeList.push(input.injectCandidates[index]!)
      continue
    }
    let failureIndex = index
    if (selector === 'kl-ucb' && trainFailures.length > 0) {
      const armIds = trainFailures.map((_f, i) => `fail_${i}`)
      for (const id of armIds) {
        if (!arms.find(arm => arm.id === id)) arms.push({ id, observations: [] })
      }
      const pick = klUcbSelect(arms, experiment.budget.usedEvals + 1, 2)
      failureIndex = Number(pick.replace('fail_', '')) || index
    }
    proposeList.push(
      proposer.propose({
        baseline,
        trainFailures,
        memory,
        seed: dataset.manifest.seed,
        index: failureIndex,
        seenDirections,
      }),
    )
  }

  for (let index = 0; index < proposeList.length; index += 1) {
    try {
      assertBudget(experiment, 1)
    } catch {
      break
    }
    const strategy = proposeList[index]
    if (!strategy) continue

    let directionKey = 'unknown'
    try {
      const tokens = parseDeliverGateStrategy(strategy)
      void tokens
      const parsed = strategy.positiveTokens && strategy.negativeTokens
        ? { p: strategy.positiveTokens, n: strategy.negativeTokens }
        : null
      if (parsed) directionKey = normalizeDirectionKey(parsed.p, parsed.n)
    } catch {
      directionKey = `invalid_${index}`
    }
    if (seenDirections.has(directionKey)) {
      candidates.push({
        candidateId: `cand_dup_${index}`,
        parentId: candidates.at(-1)?.candidateId ?? null,
        directionKey,
        lineageHash: candidateLineageHash(null, 'dup'),
        strategy,
        strategyDigest: stableJsonDigest(strategy),
        artifactDigest: '',
        status: 'rejected_duplicate',
        scores: [],
        reward: 'skip',
        proposedFrom: 'train_failures',
        rejectionReason: 'duplicate direction',
        round,
        createdAt: new Date().toISOString(),
      })
      continue
    }

    experiment.budget.usedEvals += 1
    const strategyDigest = stableJsonDigest(strategy)
    const candidateId = `cand_${round}_${index}_${strategyDigest.slice(0, 8)}`
    const parentId = candidates.filter(c => c.status === 'evaluated').at(-1)?.candidateId ?? null

    const outcome = await evaluateCandidateSearch(
      workDir,
      strategy,
      dataset.train,
      dataset.validation,
      baselineScores,
      budget,
      () => { experiment!.budget.timeouts += 1 },
      () => { experiment!.budget.errors += 1 },
    )

    const record: EvolutionCandidateRecord = {
      candidateId,
      parentId,
      directionKey,
      lineageHash: candidateLineageHash(parentId, strategyDigest),
      strategy,
      strategyDigest,
      artifactDigest: '',
      status: outcome.status,
      scores: outcome.scores,
      reward: outcome.reward,
      proposedFrom: 'train_failures',
      ...(outcome.reason ? { rejectionReason: outcome.reason } : {}),
      round,
      createdAt: new Date().toISOString(),
    }
    const archived = writeCandidateArchive(archiveDir, record)
    record.artifactDigest = archived.artifactDigest
    candidates.push({ ...record, artifactDigest: archived.artifactDigest })
    seenDirections.add(directionKey)

    if (selector === 'kl-ucb') {
      const arm = arms.find(item => item.id === `fail_${index % Math.max(trainFailures.length, 1)}`)
      if (arm) {
        arm.observations.push({
          reward: outcome.reward === 'success' ? 1 : 0,
          skip: outcome.reward === 'skip',
        })
      }
    }

    if (outcome.status === 'evaluated' && outcome.reward === 'success') break
  }

  experiment.seenDirections = [...seenDirections]
  saveExperiment(input.home, experiment)

  updatePolicyMemoryFromRound({
    home: input.home,
    experimentId: experiment.experimentId,
    round,
    trainFailureIds: trainFailures.map(item => item.id),
    completed: candidates,
  })

  const ledger: EvolutionRunReport['budget'] = { ...experiment.budget }
  const report: EvolutionRunReport = {
    schemaVersion: 2,
    domain: dataset.manifest.domain,
    runId: randomUUID(),
    experimentId: experiment.experimentId,
    round,
    datasetDigest: dataset.datasetDigest,
    evaluatorDigest,
    seed: dataset.manifest.seed,
    archiveDir,
    baseline: baselineScores,
    candidates,
    budget: ledger,
    selector,
  }
  writeRunReport(runsDir, report)
  return report
}

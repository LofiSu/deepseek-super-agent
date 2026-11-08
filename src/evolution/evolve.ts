import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  candidateLineageHash,
  writeCandidateArchive,
  writeRunReport,
  evolutionArchiveRoot,
  evolutionRunsDir,
} from './archive.ts'
import { defaultBaselineStrategy, loadSearchDatasetOnly } from './dataset.ts'
import { stableJsonDigest } from './digest.ts'
import { isolatedEvaluateSplit } from './isolate-eval.ts'
import { parseDeliverGateStrategy } from './strategy-gate.ts'
import { scoreCases, listTrainFailures } from './score.ts'
import { TrainFailureProposer } from './train-proposer.ts'
import { computeEvaluatorDigest } from './evaluator-identity.ts'
import {
  assertSearchAllowed,
  createExperiment,
  loadExperiment,
  saveExperiment,
  BASELINE_PARENT_ID,
} from './experiment.ts'
import { loadPolicyMemory, updatePolicyMemoryFromRound } from './policy-memory.ts'
import { normalizeDirectionKey } from './safe-pattern.ts'
import {
  DISCOVER_MIN_COLD_ARMS,
  recordObservation,
  type KlUcbArm,
} from './kl-ucb.ts'
import {
  collectRetiredFailureIds,
  NEW_DIRECTION_QUOTA_PER_RUN,
  selectArmId,
  selectorUsesKlUcb,
  selectorUsesMemory,
  type EvolutionSelectorMode,
} from './search-selector.ts'
import {
  EVAL_CALLS_PER_SEARCH_CANDIDATE,
  assertBudgetFrozen,
  reserveBaselineSearchUnits,
  reserveEvalUnits,
} from './budget-ledger.ts'
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

function deserializeArms(snapshot: import('./types.ts').KlArmSnapshot[]): KlUcbArm[] {
  return snapshot.map(arm => ({ id: arm.id, observations: [...arm.observations] }))
}

function serializeArms(arms: KlUcbArm[]): import('./types.ts').KlArmSnapshot[] {
  return arms.map(arm => ({ id: arm.id, observations: [...arm.observations] }))
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
    const result = await isolatedEvaluateSplit(workDir, strategy, split, cases, budget)
    if (result.timedOut) {
      onTimeout()
      return { status: 'rejected_timeout', scores: [], reason: 'eval_timeout', reward: 'skip' }
    }
    if (!result.ok || !result.score) {
      onError()
      return { status: 'rejected_eval_error', scores: [], reason: result.error ?? 'eval_failed', reward: 'skip' }
    }
    scores.push(result.score)
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
  selector?: EvolutionSelectorMode
  round?: number
  stopOnFirstSuccess?: boolean
  novelDirectionsQuotaPerRun?: number
}

export async function runEvolution(input: EvolveRunInput): Promise<EvolutionRunReport> {
  const budget = input.budget ?? DEFAULT_EVOLUTION_BUDGET
  const dataset = loadSearchDatasetOnly(input.datasetRoot)
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
  } else {
    assertSearchAllowed(experiment)
    assertBudgetFrozen(experiment, budget)
  }
  assertSearchAllowed(experiment)
  if (experiment.datasetDigest !== dataset.datasetDigest) {
    throw new Error('dataset digest mismatch for experiment')
  }
  if (experiment.evaluatorDigest !== evaluatorDigest) {
    throw new Error('evaluator digest mismatch for experiment')
  }

  const round = input.round ?? Math.max(1, experiment.seenDirections.length > 0 ? 2 : 1)
  const baseline = defaultBaselineStrategy()
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-evolution-'))
  const archiveDir = evolutionArchiveRoot(input.home)
  const runsDir = evolutionRunsDir(input.home)
  fs.mkdirSync(archiveDir, { recursive: true })

  reserveBaselineSearchUnits(input.home)
  experiment = loadExperiment(input.home)!

  const baselineScores: SplitScore[] = [
    scoreCases(baseline, 'train', dataset.train),
    scoreCases(baseline, 'validation', dataset.validation),
  ]

  const trainFailures = listTrainFailures(baseline, dataset.train)
  const memory = loadPolicyMemory(input.home, experiment.experimentId)
  const selector: EvolutionSelectorMode = input.selector ?? 'kl-ucb'
  const useMemory = selectorUsesMemory(selector)
  const proposer = input.proposer ?? new TrainFailureProposer(useMemory)
  const seenDirections = new Set(experiment.seenDirections)
  const candidates: EvolutionCandidateRecord[] = []
  const stopOnFirstSuccess = input.stopOnFirstSuccess !== false
  const novelQuota = input.novelDirectionsQuotaPerRun ?? NEW_DIRECTION_QUOTA_PER_RUN
  let roundNovelAttempted = 0
  let trialsThisRun = 0
  const maxTrialsThisRun = budget.maxCandidatesThisRun ?? budget.maxCandidates

  let arms: KlUcbArm[] = deserializeArms(experiment.klArms)
  if (selectorUsesKlUcb(selector)) {
    for (const failure of trainFailures) {
      const id = `fail_${failure.id}`
      if (!arms.find(arm => arm.id === id)) arms.push({ id, observations: [] })
    }
  }

  let parentStrategy = baseline
  let parentId: string | null = BASELINE_PARENT_ID

  const maxThisRound = budget.maxCandidates
  let injectIndex = 0
  const retiredFailureIds = collectRetiredFailureIds(memory)

  for (let step = 0; step < maxThisRound; step += 1) {
    if (experiment.totalCandidatesGenerated >= experiment.budget.maxCandidates) break
    if (trialsThisRun >= maxTrialsThisRun) break

    let strategy: DeliverGateStrategyV1 | null = null
    let failureCaseId = trainFailures[0]?.id ?? 'none'
    let selectedArmId = failureCaseId === 'none' ? 'fail_none' : `fail_${failureCaseId}`
    let selectionReason = 'inject'

    const injectedThisStep = Boolean(input.injectCandidates?.[injectIndex])
    if (injectedThisStep) {
      strategy = input.injectCandidates![injectIndex]!
      injectIndex += 1
    } else if (trainFailures.length > 0) {
      experiment.totalOpportunities += 1
      const pick = selectArmId({
        mode: selector,
        arms,
        trainFailures,
        memory,
        seenDirections,
        retiredFailureIds,
        totalOpportunities: experiment.totalOpportunities,
        roundNovelAttempted,
        novelQuota,
        seed: dataset.manifest.seed,
        discoverMinColdArms: DISCOVER_MIN_COLD_ARMS,
      })
      selectedArmId = pick.armId
      failureCaseId = pick.failureCaseId
      selectionReason = pick.selectionReason
      strategy = proposer.propose({
        baseline,
        parentStrategy,
        trainFailures,
        memory,
        seed: dataset.manifest.seed,
        failureCaseId,
        seenDirections,
        useMemory,
      })
    }

    if (!strategy) {
      candidates.push({
        candidateId: `cand_none_${round}_${step}`,
        parentId,
        directionKey: 'none',
        lineageHash: candidateLineageHash(parentId, 'none'),
        strategy: baseline,
        strategyDigest: stableJsonDigest(baseline),
        artifactDigest: '',
        status: 'skipped_invalid',
        scores: [],
        reward: 'skip',
        proposedFrom: useMemory ? 'policy_memory' : 'train_failures',
        failureCaseId,
        selectionReason: `${selectionReason};no_proposal`,
        round,
        createdAt: new Date().toISOString(),
      })
      continue
    }

    let directionKey = 'unknown'
    try {
      parseDeliverGateStrategy(strategy)
      if (strategy.positiveTokens && strategy.negativeTokens) {
        directionKey = normalizeDirectionKey(strategy.positiveTokens, strategy.negativeTokens)
      }
    } catch {
      directionKey = `invalid_${step}`
    }
    const isNovel = !seenDirections.has(directionKey)
    if (seenDirections.has(directionKey)) {
      candidates.push({
        candidateId: `cand_dup_${round}_${step}`,
        parentId,
        directionKey,
        lineageHash: candidateLineageHash(parentId, 'dup'),
        strategy,
        strategyDigest: stableJsonDigest(strategy),
        artifactDigest: '',
        status: 'rejected_duplicate',
        scores: [],
        reward: 'skip',
        proposedFrom: useMemory ? 'policy_memory' : 'train_failures',
        failureCaseId,
        selectionReason,
        rejectionReason: 'duplicate direction',
        round,
        createdAt: new Date().toISOString(),
      })
      continue
    }

    experiment.totalCandidatesGenerated += 1
    trialsThisRun += 1
    if (isNovel) roundNovelAttempted += 1
    const strategyDigest = stableJsonDigest(strategy)
    const candidateId = `cand_${round}_${step}_${strategyDigest.slice(0, 8)}`
    const actionId = stableJsonDigest({
      experimentId: experiment.experimentId,
      opportunity: experiment.totalOpportunities,
      candidateId,
    })

    reserveEvalUnits(input.home, EVAL_CALLS_PER_SEARCH_CANDIDATE, 'candidate_child_eval')
    experiment = loadExperiment(input.home)!

    const outcome = await evaluateCandidateSearch(
      workDir,
      strategy,
      dataset.train,
      dataset.validation,
      baselineScores,
      budget,
      () => { experiment!.budget.timeouts += 1; saveExperiment(input.home, experiment!) },
      () => { experiment!.budget.errors += 1; saveExperiment(input.home, experiment!) },
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
      proposedFrom: useMemory ? 'policy_memory' : selectorUsesKlUcb(selector) ? 'train_failures' : 'train_failures',
      failureCaseId,
      selectionReason,
      ...(outcome.reason ? { rejectionReason: outcome.reason } : {}),
      round,
      createdAt: new Date().toISOString(),
    }
    const archived = writeCandidateArchive(archiveDir, record)
    record.artifactDigest = archived.artifactDigest
    candidates.push(record)
    seenDirections.add(directionKey)

    if (selectorUsesKlUcb(selector) && arms.length > 0 && !injectedThisStep) {
      recordObservation(arms, selectedArmId, {
        id: actionId,
        reward: outcome.reward === 'success' ? 1 : 0,
        skip: outcome.reward === 'skip',
      })
    }

    experiment.klArms = serializeArms(arms)
    experiment.seenDirections = [...seenDirections]
    saveExperiment(input.home, experiment)

    if (stopOnFirstSuccess && outcome.status === 'evaluated' && outcome.reward === 'success') {
      parentStrategy = strategy
      parentId = candidateId
      break
    }
  }

  experiment = loadExperiment(input.home)!
  updatePolicyMemoryFromRound({
    home: input.home,
    experimentId: experiment.experimentId,
    round,
    completed: candidates,
  })

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
    budget: { ...experiment.budget },
    selector,
  }
  writeRunReport(runsDir, report)
  return report
}

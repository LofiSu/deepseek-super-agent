import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  BudgetLedger,
  ExperimentFinalTestRecord,
  ExperimentState,
  EvolutionRunReport,
  FrozenSelection,
} from './types.ts'
import { writeJsonAtomic, readJsonFile, resolveInsideDir, resolveTrustedEvolutionRoot } from './io.ts'
import { DEFAULT_EVOLUTION_BUDGET } from './types.ts'
import { evolutionArchiveRoot, evolutionRunsDir } from './archive.ts'
import { sealArtifactDigest } from './archive.ts'
import { stableJsonDigest } from './digest.ts'
import type { EvolutionCandidateRecord } from './types.ts'
import {
  acquireFinalTestClaimLock,
  markFinalTestClaimConsumed,
  releaseFinalTestClaimLock,
} from './final-test-claim-lock.ts'
import { acquireSearchRunLock, releaseSearchRunLock } from './search-run-lock.ts'

export const BASELINE_PARENT_ID = 'baseline_immutable'

export function experimentPath(home: string): string {
  return path.join(resolveTrustedEvolutionRoot(home), 'experiment.json')
}

export function runReceiptPath(home: string): string {
  return path.join(resolveTrustedEvolutionRoot(home), 'frozen-run-receipt.json')
}

export function defaultBudgetLedger(overrides?: Partial<BudgetLedger>): BudgetLedger {
  return {
    maxCandidates: DEFAULT_EVOLUTION_BUDGET.maxCandidates,
    maxEvals: DEFAULT_EVOLUTION_BUDGET.maxEvals,
    evalTimeoutMs: DEFAULT_EVOLUTION_BUDGET.evalTimeoutMs,
    maxOutputBytes: DEFAULT_EVOLUTION_BUDGET.maxOutputBytes ?? 65_536,
    reserveEvals: DEFAULT_EVOLUTION_BUDGET.reserveEvals ?? 8,
    usedEvals: 0,
    errors: 0,
    timeouts: 0,
    providerCalls: 0,
    reservations: [],
    finaltestReserved: false,
    ...overrides,
  }
}

export function loadExperiment(home: string): ExperimentState | null {
  const file = experimentPath(home)
  if (!fs.existsSync(file)) return null
  const root = resolveTrustedEvolutionRoot(home)
  return readJsonFile<ExperimentState>(file, root)
}

export function saveExperiment(home: string, state: ExperimentState): void {
  writeJsonAtomic(experimentPath(home), state)
}

/** Load → mutate → save in one transaction (prevents stale overwrites). */
export function mutateExperiment(
  home: string,
  mutator: (state: ExperimentState) => void,
): ExperimentState {
  const state = loadExperiment(home)
  if (!state) throw new Error('missing experiment')
  mutator(state)
  saveExperiment(home, state)
  return state
}

export function loadPersistedRunReport(home: string, runId: string): EvolutionRunReport {
  if (!/^[a-zA-Z0-9_.-]+$/.test(runId)) {
    throw new Error('invalid run id')
  }
  const evolutionRoot = resolveTrustedEvolutionRoot(home)
  const file = path.join(evolutionRunsDir(home), `${runId}.json`)
  const resolved = resolveInsideDir(evolutionRoot, file)
  return readJsonFile<EvolutionRunReport>(resolved, evolutionRoot)
}

export function loadFrozenRunReceipt(home: string): EvolutionRunReport | null {
  const file = runReceiptPath(home)
  if (!fs.existsSync(file)) return null
  const root = resolveTrustedEvolutionRoot(home)
  return readJsonFile<EvolutionRunReport>(file, root)
}

export function createExperiment(input: {
  home: string
  datasetDigest: string
  evaluatorDigest: string
  seed: number
  budget?: Partial<BudgetLedger>
}): ExperimentState {
  const state: ExperimentState = {
    experimentId: randomUUID(),
    phase: 'search',
    datasetDigest: input.datasetDigest,
    evaluatorDigest: input.evaluatorDigest,
    seed: input.seed,
    selectedCandidateId: null,
    frozenSelection: null,
    frozenAt: null,
    finalizedAt: null,
    finalTest: null,
    finalTestClaim: null,
    budget: defaultBudgetLedger(input.budget),
    seenDirections: [],
    totalCandidatesGenerated: 0,
    totalOpportunities: 0,
    klArms: [],
    frozenRunReceipt: null,
  }
  saveExperiment(input.home, state)
  return state
}

export function assertSearchAllowed(state: ExperimentState): void {
  if (state.phase === 'finalized') {
    throw new Error('experiment finalized; search refused')
  }
  if (state.phase === 'frozen') {
    throw new Error('experiment frozen; search refused')
  }
  if (state.finalTest !== null) {
    throw new Error('final test already recorded; search refused')
  }
  if (state.finalTestClaim?.state === 'CLAIMED' || state.finalTestClaim?.state === 'RUNNING') {
    throw new Error('final test claim open; search refused')
  }
}

function loadArtifactRecord(home: string, candidateId: string): EvolutionCandidateRecord {
  if (!/^[a-zA-Z0-9_.-]+$/.test(candidateId)) {
    throw new Error('invalid candidate id')
  }
  const archiveRoot = evolutionArchiveRoot(home)
  const artifact = path.join(archiveRoot, candidateId, 'candidate.json')
  const resolved = resolveInsideDir(archiveRoot, artifact)
  const record = readJsonFile<EvolutionCandidateRecord>(resolved, archiveRoot)
  const digest = sealArtifactDigest(record)
  if (record.artifactDigest !== digest) {
    throw new Error('artifact content digest mismatch at load')
  }
  return record
}

export function freezeCandidate(input: {
  home: string
  candidateId: string
  runId?: string
  runReport?: EvolutionRunReport
}): ExperimentState {
  // Freeze and search share one exclusive lock, so a search run cannot continue
  // against an experiment that is being frozen (and vice versa).
  const searchLock = acquireSearchRunLock(input.home)
  try {
  const state = loadExperiment(input.home)
  if (!state) throw new Error('no experiment')
  assertSearchAllowed(state)

  const runId = input.runId ?? input.runReport?.runId
  if (!runId) throw new Error('freeze requires persisted runId')
  const runReport = loadPersistedRunReport(input.home, runId)

  if (runReport.experimentId !== state.experimentId) {
    throw new Error('run report experiment mismatch')
  }
  if (runReport.datasetDigest !== state.datasetDigest) {
    throw new Error('run report dataset mismatch')
  }
  if (runReport.evaluatorDigest !== state.evaluatorDigest) {
    throw new Error('run report evaluator mismatch')
  }
  if (input.runReport && stableJsonDigest(input.runReport) !== stableJsonDigest(runReport)) {
    throw new Error('run report forgery vs persisted runs artifact')
  }

  const candidate = runReport.candidates.find(item => item.candidateId === input.candidateId)
  if (!candidate || candidate.status !== 'evaluated') {
    throw new Error('freeze requires evaluated candidate from persisted run')
  }
  const artifact = loadArtifactRecord(input.home, input.candidateId)
  if (artifact.strategyDigest !== candidate.strategyDigest) {
    throw new Error('candidate strategy digest mismatch vs archive')
  }
  const artifactPath = path.join(evolutionArchiveRoot(input.home), input.candidateId, 'candidate.json')
  const selection: FrozenSelection = {
    candidateId: input.candidateId,
    artifactDigest: artifact.artifactDigest,
    strategyDigest: candidate.strategyDigest,
    runId: runReport.runId,
    artifactPath,
    frozenAt: new Date().toISOString(),
  }
  state.phase = 'frozen'
  state.selectedCandidateId = input.candidateId
  state.frozenSelection = selection
  state.frozenAt = selection.frozenAt
  state.frozenRunReceipt = runReport
  writeJsonAtomic(runReceiptPath(input.home), runReport)
  saveExperiment(input.home, state)
  return state
  } finally {
    releaseSearchRunLock(input.home, searchLock.lockToken)
  }
}

export function recordFinalTest(home: string, record: ExperimentFinalTestRecord): ExperimentState {
  const state = loadExperiment(home)
  if (!state) throw new Error('no experiment')
  if (state.phase !== 'frozen') throw new Error('must freeze before final test')
  if (state.finalTest !== null) throw new Error('final test already opened exactly once')
  state.finalTest = record
  state.phase = 'finalized'
  state.finalizedAt = record.closedAt
  if (state.finalTestClaim) {
    state.finalTestClaim.state = record.scores.length ? 'SUCCEEDED' : 'FAILED'
    state.finalTestClaim.closedAt = record.closedAt
  }
  saveExperiment(home, state)
  return state
}

export function openFinalTestLedger(candidateId: string, digests: {
  strategyDigest: string
  datasetDigest: string
  evaluatorDigest: string
}): ExperimentFinalTestRecord {
  const openedAt = new Date().toISOString()
  return {
    ledgerId: randomUUID(),
    openedAt,
    closedAt: openedAt,
    scores: [],
    candidateId,
    strategyDigest: digests.strategyDigest,
    datasetDigest: digests.datasetDigest,
    evaluatorDigest: digests.evaluatorDigest,
  }
}

/** Exclusive OS lock + experiment claim before reading finaltest.json. */
export function claimFinalTest(home: string, candidateId: string): {
  state: ExperimentState
  lockToken: string
} {
  const lock = acquireFinalTestClaimLock(home, candidateId)
  try {
    const state = loadExperiment(home)
    if (!state) throw new Error('no experiment')
    if (state.phase !== 'frozen' || !state.frozenSelection) throw new Error('must freeze before final test claim')
    if (state.frozenSelection.candidateId !== candidateId) {
      throw new Error('candidate not frozen selection')
    }
    if (state.finalTest !== null) throw new Error('final test already finalized')
    if (state.finalTestClaim) {
      throw new Error(`final test claim already ${state.finalTestClaim.state}`)
    }
    state.finalTestClaim = {
      claimId: lock.claimToken,
      state: 'CLAIMED',
      openedAt: lock.openedAt,
      candidateId,
      strategyDigest: state.frozenSelection.strategyDigest,
    }
    saveExperiment(home, state)
    return { state, lockToken: lock.claimToken }
  } catch (error) {
    try {
      releaseFinalTestClaimLock(home, lock.claimToken)
    } catch {
      /* ignore */
    }
    throw error
  }
}

export function markFinalTestRunning(home: string): void {
  const state = loadExperiment(home)
  if (!state?.finalTestClaim) throw new Error('no claim')
  state.finalTestClaim.state = 'RUNNING'
  saveExperiment(home, state)
}

export function abortFinalTestClaim(home: string, lockToken: string, reason: string): never {
  const state = loadExperiment(home)
  if (!state?.finalTestClaim) {
    markFinalTestClaimConsumed(home, lockToken, 'FAILED')
    throw new Error(reason)
  }
  state.finalTestClaim.state = 'FAILED'
  state.finalTestClaim.closedAt = new Date().toISOString()
  if (!state.finalTest) {
    state.phase = 'finalized'
    state.finalizedAt = state.finalTestClaim.closedAt
  }
  saveExperiment(home, state)
  markFinalTestClaimConsumed(home, lockToken, 'FAILED')
  throw new Error(reason)
}

export function markFinalTestConsumed(home: string, ok: boolean, lockToken?: string): void {
  const state = loadExperiment(home)
  if (!state?.finalTestClaim) return
  state.finalTestClaim.state = ok ? 'SUCCEEDED' : 'FAILED'
  state.finalTestClaim.closedAt = new Date().toISOString()
  if (!ok && !state.finalTest) {
    state.phase = 'finalized'
    state.finalizedAt = state.finalTestClaim.closedAt
  }
  saveExperiment(home, state)
  if (lockToken) {
    markFinalTestClaimConsumed(home, lockToken, ok ? 'SUCCEEDED' : 'FAILED')
  }
}

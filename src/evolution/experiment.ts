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
import { writeJsonAtomic, readJsonFile, resolveInsideDir } from './io.ts'
import { DEFAULT_EVOLUTION_BUDGET } from './types.ts'
import { evolutionArchiveRoot } from './archive.ts'
import { sealArtifactDigest } from './archive.ts'
import type { EvolutionCandidateRecord } from './types.ts'

export const BASELINE_PARENT_ID = 'baseline_immutable'

export function experimentPath(home: string): string {
  return path.join(home, 'evolution', 'experiment.json')
}

export function runReceiptPath(home: string): string {
  return path.join(home, 'evolution', 'frozen-run-receipt.json')
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
  return readJsonFile<ExperimentState>(file)
}

export function saveExperiment(home: string, state: ExperimentState): void {
  writeJsonAtomic(experimentPath(home), state)
}

export function loadFrozenRunReceipt(home: string): EvolutionRunReport | null {
  const file = runReceiptPath(home)
  if (!fs.existsSync(file)) return null
  return readJsonFile<EvolutionRunReport>(file)
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

export function assertBudget(state: ExperimentState, evalCost: number): void {
  const searchPool = state.budget.maxEvals - state.budget.reserveEvals
  if (state.budget.usedEvals + evalCost > searchPool) {
    throw new Error('budget exhausted (reserve held for final test)')
  }
}

function loadArtifactRecord(home: string, candidateId: string): EvolutionCandidateRecord {
  if (!/^[a-zA-Z0-9_.-]+$/.test(candidateId)) {
    throw new Error('invalid candidate id')
  }
  const archiveRoot = evolutionArchiveRoot(home)
  const artifact = path.join(archiveRoot, candidateId, 'candidate.json')
  const resolved = resolveInsideDir(archiveRoot, artifact)
  return readJsonFile<EvolutionCandidateRecord>(resolved)
}

export function freezeCandidate(input: {
  home: string
  candidateId: string
  runReport: EvolutionRunReport
}): ExperimentState {
  const state = loadExperiment(input.home)
  if (!state) throw new Error('no experiment')
  assertSearchAllowed(state)
  const candidate = input.runReport.candidates.find(item => item.candidateId === input.candidateId)
  if (!candidate || candidate.status !== 'evaluated') {
    throw new Error('freeze requires evaluated candidate from this run')
  }
  const artifact = loadArtifactRecord(input.home, input.candidateId)
  const digest = sealArtifactDigest(artifact)
  if (artifact.artifactDigest !== digest) {
    throw new Error('artifact digest mismatch at freeze')
  }
  const artifactPath = path.join(evolutionArchiveRoot(input.home), input.candidateId, 'candidate.json')
  const selection: FrozenSelection = {
    candidateId: input.candidateId,
    artifactDigest: artifact.artifactDigest,
    strategyDigest: candidate.strategyDigest,
    runId: input.runReport.runId,
    artifactPath,
    frozenAt: new Date().toISOString(),
  }
  state.phase = 'frozen'
  state.selectedCandidateId = input.candidateId
  state.frozenSelection = selection
  state.frozenAt = selection.frozenAt
  state.frozenRunReceipt = input.runReport
  writeJsonAtomic(runReceiptPath(input.home), input.runReport)
  saveExperiment(input.home, state)
  return state
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

/** Exclusive claim before reading finaltest.json (fail-closed on concurrent second claim). */
export function claimFinalTest(home: string, candidateId: string): ExperimentState {
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
    claimId: randomUUID(),
    state: 'CLAIMED',
    openedAt: new Date().toISOString(),
    candidateId,
    strategyDigest: state.frozenSelection.strategyDigest,
  }
  saveExperiment(home, state)
  return state
}

export function markFinalTestRunning(home: string): void {
  const state = loadExperiment(home)
  if (!state?.finalTestClaim) throw new Error('no claim')
  state.finalTestClaim.state = 'RUNNING'
  saveExperiment(home, state)
}

export function markFinalTestConsumed(home: string, ok: boolean): void {
  const state = loadExperiment(home)
  if (!state?.finalTestClaim) return
  state.finalTestClaim.state = ok ? 'SUCCEEDED' : 'FAILED'
  state.finalTestClaim.closedAt = new Date().toISOString()
  if (!ok && !state.finalTest) {
    state.phase = 'finalized'
    state.finalizedAt = state.finalTestClaim.closedAt
  }
  saveExperiment(home, state)
}

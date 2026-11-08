import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BudgetLedger, ExperimentFinalTestRecord, ExperimentState } from './types.ts'
import { writeJsonAtomic, readJsonFile } from './io.ts'
import { DEFAULT_EVOLUTION_BUDGET } from './types.ts'

export function experimentPath(home: string): string {
  return path.join(home, 'evolution', 'experiment.json')
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
    frozenAt: null,
    finalizedAt: null,
    finalTest: null,
    budget: defaultBudgetLedger(input.budget),
    seenDirections: [],
  }
  saveExperiment(input.home, state)
  return state
}

export function assertSearchAllowed(state: ExperimentState): void {
  if (state.phase === 'finalized') {
    throw new Error('experiment finalized; search refused')
  }
  if (state.finalTest !== null) {
    throw new Error('final test already recorded; search refused')
  }
}

export function assertBudget(state: ExperimentState, evalCost = 1): void {
  const avail = state.budget.maxEvals - state.budget.reserveEvals
  if (state.budget.usedEvals + evalCost > avail) {
    throw new Error('budget exhausted (reserve held for final test)')
  }
}

export function freezeCandidate(home: string, candidateId: string): ExperimentState {
  const state = loadExperiment(home)
  if (!state) throw new Error('no experiment')
  assertSearchAllowed(state)
  state.phase = 'frozen'
  state.selectedCandidateId = candidateId
  state.frozenAt = new Date().toISOString()
  saveExperiment(home, state)
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

import type { BudgetLedger, ExperimentState } from './types.ts'
import { loadExperiment, saveExperiment } from './experiment.ts'

export const EVAL_CALLS_PER_SEARCH_CANDIDATE = 2
export const EVAL_CALLS_BASELINE_SEARCH = 2
export const EVAL_CALLS_FINALTEST = 2

export function assertBudgetFrozen(state: ExperimentState, incoming: Partial<BudgetLedger>): void {
  const b = state.budget
  for (const key of ['maxEvals', 'maxCandidates', 'evalTimeoutMs', 'maxOutputBytes', 'reserveEvals'] as const) {
    if (incoming[key] !== undefined && incoming[key] !== b[key]) {
      throw new Error(`budget immutable on resume: ${key}`)
    }
  }
}

/**
 * Reserve eval units BEFORE launching work; persist immediately so crash consumes cost.
 */
export function reserveEvalUnits(home: string, units: number, reason: string): ExperimentState {
  const state = loadExperiment(home)
  if (!state) throw new Error('missing experiment for budget reserve')
  const searchPool = state.budget.maxEvals - state.budget.reserveEvals
  if (state.budget.usedEvals + units > searchPool) {
    throw new Error(`budget exhausted: ${reason}`)
  }
  state.budget.usedEvals += units
  state.budget.reservations = state.budget.reservations ?? []
  state.budget.reservations.push({
    units,
    reason,
    at: new Date().toISOString(),
    consumed: true,
  })
  saveExperiment(home, state)
  return state
}

export function reserveBaselineSearchUnits(home: string): ExperimentState {
  const state = loadExperiment(home)
  if (!state) throw new Error('missing experiment')
  if (state.budget.baselineSearchReserved) return state
  const searchPool = state.budget.maxEvals - state.budget.reserveEvals
  if (state.budget.usedEvals + EVAL_CALLS_BASELINE_SEARCH > searchPool) {
    throw new Error('budget exhausted: baseline_search_splits')
  }
  state.budget.usedEvals += EVAL_CALLS_BASELINE_SEARCH
  state.budget.baselineSearchReserved = true
  state.budget.reservations = state.budget.reservations ?? []
  state.budget.reservations.push({
    units: EVAL_CALLS_BASELINE_SEARCH,
    reason: 'baseline_search_splits',
    at: new Date().toISOString(),
    consumed: true,
  })
  saveExperiment(home, state)
  return state
}

export function reserveFinalTestUnits(home: string): ExperimentState {
  const state = loadExperiment(home)
  if (!state) throw new Error('missing experiment')
  if (state.budget.finaltestReserved) throw new Error('final test budget already reserved')
  state.budget.usedEvals += EVAL_CALLS_FINALTEST
  state.budget.finaltestReserved = true
  saveExperiment(home, state)
  return state
}

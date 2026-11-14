import type { BudgetLedger, ExperimentState } from './types.ts'
import { assertSearchAllowed, loadExperiment, mutateExperiment } from './experiment.ts'

export const EVAL_CALLS_PER_SEARCH_CANDIDATE = 2
export const EVAL_CALLS_BASELINE_SEARCH = 2
export const EVAL_CALLS_FINALTEST = 2

function searchUnitsUsed(state: ExperimentState): number {
  return (state.budget.reservations ?? [])
    .filter(item => !item.reason.startsWith('finaltest_'))
    .reduce((sum, item) => sum + item.units, 0)
}

function finaltestUnitsUsed(state: ExperimentState): number {
  return (state.budget.reservations ?? [])
    .filter(item => item.reason.startsWith('finaltest_'))
    .reduce((sum, item) => sum + item.units, 0)
}

function pushReservation(state: ExperimentState, units: number, reason: string): void {
  state.budget.reservations = state.budget.reservations ?? []
  state.budget.reservations.push({
    units,
    reason,
    at: new Date().toISOString(),
    consumed: true,
  })
  state.budget.usedEvals += units
}

export function assertBudgetFrozen(state: ExperimentState, incoming: Partial<BudgetLedger>): void {
  const b = state.budget
  for (const key of ['maxEvals', 'maxCandidates', 'evalTimeoutMs', 'maxOutputBytes', 'reserveEvals'] as const) {
    if (incoming[key] !== undefined && incoming[key] !== b[key]) {
      throw new Error(`budget immutable on resume: ${key}`)
    }
  }
}

/**
 * Reserve search-pool eval units and apply experiment counters in one persisted write.
 */
export function reserveSearchEvalUnits(
  home: string,
  units: number,
  reason: string,
  patch?: (state: ExperimentState) => void,
): ExperimentState {
  return mutateExperiment(home, state => {
    assertSearchAllowed(state)
    const searchPool = state.budget.maxEvals - state.budget.reserveEvals
    if (searchUnitsUsed(state) + units > searchPool) {
      throw new Error(`budget exhausted: ${reason}`)
    }
    pushReservation(state, units, reason)
    patch?.(state)
  })
}

/** @deprecated use reserveSearchEvalUnits */
export function reserveEvalUnits(home: string, units: number, reason: string): ExperimentState {
  return reserveSearchEvalUnits(home, units, reason)
}

export function reserveBaselineSearchUnits(home: string): ExperimentState {
  return mutateExperiment(home, state => {
    assertSearchAllowed(state)
    if (state.budget.baselineSearchReserved) return
    const searchPool = state.budget.maxEvals - state.budget.reserveEvals
    if (searchUnitsUsed(state) + EVAL_CALLS_BASELINE_SEARCH > searchPool) {
      throw new Error('budget exhausted: baseline_search_splits')
    }
    pushReservation(state, EVAL_CALLS_BASELINE_SEARCH, 'baseline_search_splits')
    state.budget.baselineSearchReserved = true
  })
}

export function reserveFinalTestUnits(home: string): ExperimentState {
  return mutateExperiment(home, state => {
    if (state.budget.finaltestReserved) throw new Error('final test budget already reserved')
    const reservePool = state.budget.reserveEvals
    if (finaltestUnitsUsed(state) + EVAL_CALLS_FINALTEST > reservePool) {
      throw new Error('final test reserve pool exhausted (reserveEvals)')
    }
    pushReservation(state, EVAL_CALLS_FINALTEST, 'finaltest_child_eval')
    state.budget.finaltestReserved = true
  })
}

export function recordChildEvalLaunch(home: string, count = 1): void {
  mutateExperiment(home, state => {
    assertSearchAllowed(state)
    state.budget.childEvalLaunches = (state.budget.childEvalLaunches ?? 0) + count
  })
}

/**
 * Post-freeze final-test path: search is already refused, so this is the one
 * child-eval counter that may run on a frozen experiment.
 */
export function recordFinalTestChildEvalLaunch(home: string, count = 1): void {
  mutateExperiment(home, state => {
    state.budget.childEvalLaunches = (state.budget.childEvalLaunches ?? 0) + count
  })
}

export function bumpBudgetCounters(
  home: string,
  input: { timeouts?: number; errors?: number },
): void {
  mutateExperiment(home, state => {
    assertSearchAllowed(state)
    if (input.timeouts) state.budget.timeouts += input.timeouts
    if (input.errors) state.budget.errors += input.errors
  })
}

export function persistExperimentCounters(
  home: string,
  input: {
    totalOpportunities?: number
    totalCandidatesGenerated?: number
    klArms?: ExperimentState['klArms']
    seenDirections?: string[]
    baselineSearchCache?: ExperimentState['baselineSearchCache']
  },
): ExperimentState {
  return mutateExperiment(home, state => {
    assertSearchAllowed(state)
    if (input.totalOpportunities !== undefined) {
      state.totalOpportunities = input.totalOpportunities
    }
    if (input.totalCandidatesGenerated !== undefined) {
      if (input.totalCandidatesGenerated > state.budget.maxCandidates) {
        throw new Error('maxCandidates exceeded')
      }
      state.totalCandidatesGenerated = input.totalCandidatesGenerated
    }
    if (input.klArms !== undefined) state.klArms = input.klArms
    if (input.seenDirections !== undefined) state.seenDirections = input.seenDirections
    if (input.baselineSearchCache !== undefined) state.baselineSearchCache = input.baselineSearchCache
  })
}

export function assertMaxCandidatesNotExceeded(home: string): void {
  const state = loadExperiment(home)
  if (!state) throw new Error('missing experiment')
  if (state.totalCandidatesGenerated >= state.budget.maxCandidates) {
    throw new Error('maxCandidates exhausted')
  }
}

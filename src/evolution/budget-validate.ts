import type { EvolutionBudget } from './types.ts'
import { EVAL_CALLS_BASELINE_SEARCH, EVAL_CALLS_FINALTEST } from './budget-constants.ts'
import { DEFAULT_EVOLUTION_BUDGET } from './types.ts'

const BUDGET_INT_KEYS = ['maxCandidates', 'maxEvals', 'evalTimeoutMs', 'maxOutputBytes', 'reserveEvals', 'maxCandidatesThisRun'] as const

export function assertValidEvolutionBudget(budget: Partial<EvolutionBudget>, label = 'budget'): void {
  for (const key of BUDGET_INT_KEYS) {
    const v = budget[key]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
      throw new Error(`${label}: invalid ${key}`)
    }
  }
  const maxCandidates = budget.maxCandidates
  if (maxCandidates !== undefined && maxCandidates < 1) {
    throw new Error(`${label}: maxCandidates must be >= 1`)
  }
  const maxEvals = budget.maxEvals
  const reserveEvals = budget.reserveEvals
  // An omitted reserveEvals keeps its later default. An explicit value below
  // the final-test reservation can never fund the sealed holdout.
  if (reserveEvals !== undefined && reserveEvals < EVAL_CALLS_FINALTEST) {
    throw new Error(
      `${label}: reserveEvals must be >= ${EVAL_CALLS_FINALTEST} to fund the final test`,
    )
  }
  const effectiveMaxEvals = maxEvals ?? DEFAULT_EVOLUTION_BUDGET.maxEvals
  const effectiveReserveEvals = reserveEvals ?? DEFAULT_EVOLUTION_BUDGET.reserveEvals ?? 8
  if (effectiveReserveEvals > effectiveMaxEvals) {
    throw new Error(`${label}: reserveEvals exceeds maxEvals`)
  }
  if (effectiveMaxEvals - effectiveReserveEvals < EVAL_CALLS_BASELINE_SEARCH) {
    throw new Error(
      `${label}: search pool must be >= ${EVAL_CALLS_BASELINE_SEARCH} to fund baseline search`,
    )
  }
  const evalTimeoutMs = budget.evalTimeoutMs
  if (evalTimeoutMs !== undefined && evalTimeoutMs < 1) {
    throw new Error(`${label}: evalTimeoutMs must be >= 1`)
  }
  const maxOutputBytes = budget.maxOutputBytes
  if (maxOutputBytes !== undefined && maxOutputBytes < 1) {
    throw new Error(`${label}: maxOutputBytes must be >= 1`)
  }
}

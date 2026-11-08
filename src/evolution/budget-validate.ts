import type { EvolutionBudget } from './types.ts'

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
  const reserveEvals = budget.reserveEvals ?? 0
  if (maxEvals !== undefined && reserveEvals > maxEvals) {
    throw new Error(`${label}: reserveEvals exceeds maxEvals`)
  }
  const evalTimeoutMs = budget.evalTimeoutMs
  if (evalTimeoutMs !== undefined && evalTimeoutMs < 1) {
    throw new Error(`${label}: evalTimeoutMs must be >= 1`)
  }
}

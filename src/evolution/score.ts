import type { EvolutionEvalCase, SplitScore } from './types.ts'
import { evaluateDeliverGateStrategy } from './strategy-gate.ts'
import type { DeliverGateStrategyV1 } from './types.ts'

export const EVALUATOR_VERSION = 'evolution-evaluator-1' as const

export function scoreCases(
  strategy: DeliverGateStrategyV1,
  split: SplitScore['split'],
  cases: EvolutionEvalCase[],
): SplitScore {
  let correct = 0
  for (const item of cases) {
    const predicted = evaluateDeliverGateStrategy(strategy, {
      speculative: item.speculative,
      report: item.report,
    })
    if (predicted === item.expected) correct += 1
  }
  const total = cases.length
  const accuracy = total > 0 ? correct / total : 0
  if (!Number.isFinite(accuracy)) throw new Error('NaN accuracy')
  return { split, correct, total, accuracy }
}

export function listTrainFailures(
  baseline: DeliverGateStrategyV1,
  train: EvolutionEvalCase[],
): EvolutionEvalCase[] {
  return train.filter(item => {
    const predicted = evaluateDeliverGateStrategy(baseline, {
      speculative: item.speculative,
      report: item.report,
    })
    return predicted !== item.expected
  })
}

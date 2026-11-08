import type { CandidateProposer } from './types.ts'
import type { DeliverGateStrategyV1, EvolutionEvalCase } from './types.ts'
import { evaluateDeliverGateStrategy } from './strategy-gate.ts'

function missingTokens(text: string, pattern: string): string[] {
  const words = text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []
  const body = pattern.toLowerCase()
  return [...new Set(words)].filter(word => !body.includes(word)).slice(0, 6)
}

/**
 * Train-failure-driven proposals (SICA/DGM-style archive feedback) without LLM calls.
 * Adds tokens from misclassified train reports into the positive/negative regex lists.
 */
export class TrainFailureProposer implements CandidateProposer {
  propose(input: {
    baseline: DeliverGateStrategyV1
    trainFailures: EvolutionEvalCase[]
    seed: number
    index: number
  }): DeliverGateStrategyV1 | null {
    const { baseline, trainFailures, index } = input
    if (trainFailures.length === 0) return null
    const failure = trainFailures[index % trainFailures.length]
    if (!failure) return null
    const predicted = evaluateDeliverGateStrategy(baseline, {
      speculative: failure.speculative,
      report: failure.report,
    })
    if (predicted === failure.expected) return null

    let negativePattern = baseline.negativePattern
    let positivePattern = baseline.positivePattern
    if (failure.expected === 'deliver' && predicted === 'discard') {
      const extra = missingTokens(failure.report.text, positivePattern)
      if (extra.length === 0) return null
      const alt = extra[0]!
      const inner = positivePattern.replace(/^\\b\(/, '\\b(').replace(/\)\\b$/u, '')
      if (inner.includes(alt)) return null
      positivePattern = positivePattern.replace(
        /\)\\b$/u,
        `|${alt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`,
      )
    } else if (failure.expected === 'discard' && predicted === 'deliver') {
      const extra = missingTokens(failure.report.text, negativePattern)
      if (extra.length === 0) return null
      const alt = extra[0]!
      negativePattern = negativePattern.replace(
        /\)\\b$/u,
        `|${alt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`,
      )
    } else {
      return null
    }

    return {
      ...baseline,
      negativePattern,
      positivePattern,
    }
  }
}

/** Deterministic mock proposer for unit tests of the archive path. */
export class MockFixtureProposer implements CandidateProposer {
  constructor(private readonly variants: DeliverGateStrategyV1[]) {}

  propose(input: {
    baseline: DeliverGateStrategyV1
    trainFailures: EvolutionEvalCase[]
    seed: number
    index: number
  }): DeliverGateStrategyV1 | null {
    return this.variants[input.index] ?? null
  }
}

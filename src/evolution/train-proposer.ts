import type { CandidateProposer } from './types.ts'
import type { DeliverGateStrategyV1, EvolutionEvalCase } from './types.ts'
import { evaluateDeliverGateStrategy, strategyTokens } from './strategy-gate.ts'
import { assertSafeToken, normalizeDirectionKey } from './safe-pattern.ts'
import { EVOLUTION_SCHEMA_VERSION, DELIVER_GATE_DOMAIN } from './types.ts'

function missingTokens(text: string, known: readonly string[]): string[] {
  const words = text.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) ?? []
  const body = known.join(' ')
  return [...new Set(words)].filter(word => !body.includes(word)).slice(0, 6)
}

/**
 * Train-failure + policy-memory driven token proposals (deterministic; not LLM code gen).
 */
export class TrainFailureProposer implements CandidateProposer {
  propose(input: {
    baseline: DeliverGateStrategyV1
    trainFailures: EvolutionEvalCase[]
    memory: import('./types.ts').PolicyMemoryCarrier
    seed: number
    index: number
    seenDirections: Set<string>
  }): DeliverGateStrategyV1 | null {
    const { baseline, trainFailures, memory, index, seenDirections } = input
    if (trainFailures.length === 0) return null
    const failure = trainFailures[index % trainFailures.length]
    if (!failure) return null
    const predicted = evaluateDeliverGateStrategy(baseline, {
      speculative: failure.speculative,
      report: failure.report,
    })
    if (predicted === failure.expected) return null

    const tokens = strategyTokens(baseline)
    let positiveTokens = [...tokens.positiveTokens]
    let negativeTokens = [...tokens.negativeTokens]

    const memoryHint = memory.lessons
      .filter(lesson => lesson.status === 'active')
      .map(lesson => lesson.recommendedChange)
      .join(' ')

    if (failure.expected === 'deliver' && predicted === 'discard') {
      const extra = missingTokens(failure.report.text, positiveTokens)
      let alt = extra[0]
      if (memoryHint.includes('checkout') && !positiveTokens.includes('checkout')) alt = 'checkout'
      if (!alt) return null
      try {
        assertSafeToken(alt, 'proposed')
      } catch {
        return null
      }
      if (positiveTokens.includes(alt)) return null
      positiveTokens = [...positiveTokens, alt]
    } else if (failure.expected === 'discard' && predicted === 'deliver') {
      const extra = missingTokens(failure.report.text, negativeTokens)
      const alt = extra[0]
      if (!alt) return null
      try {
        assertSafeToken(alt, 'proposed')
      } catch {
        return null
      }
      if (negativeTokens.includes(alt)) return null
      negativeTokens = [...negativeTokens, alt]
    } else {
      return null
    }

    const directionKey = normalizeDirectionKey(positiveTokens, negativeTokens)
    if (seenDirections.has(directionKey)) return null

    return {
      schemaVersion: EVOLUTION_SCHEMA_VERSION,
      domain: DELIVER_GATE_DOMAIN,
      positiveTokens,
      negativeTokens,
      clauseLocalPositive: baseline.clauseLocalPositive,
    }
  }
}

export class MockFixtureProposer implements CandidateProposer {
  constructor(private readonly variants: DeliverGateStrategyV1[]) {}

  propose(input: {
    baseline: DeliverGateStrategyV1
    trainFailures: EvolutionEvalCase[]
    memory: import('./types.ts').PolicyMemoryCarrier
    seed: number
    index: number
    seenDirections: Set<string>
  }): DeliverGateStrategyV1 | null {
    return this.variants[input.index] ?? null
  }
}

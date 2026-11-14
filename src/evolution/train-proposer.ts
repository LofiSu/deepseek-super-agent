import type { CandidateProposer } from './types.ts'
import type { DeliverGateStrategyV1, EvolutionEvalCase } from './types.ts'
import { evaluateDeliverGateStrategy, strategyTokens } from './strategy-gate.ts'
import { assertSafeToken, normalizeDirectionKey } from './safe-pattern.ts'
import { EVOLUTION_SCHEMA_VERSION, DELIVER_GATE_DOMAIN } from './types.ts'
import { applyMemoryLessons } from './policy-memory.ts'

function missingTokens(text: string, known: readonly string[]): string[] {
  const words = text.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) ?? []
  const knownExact = new Set(known.map(token => token.toLowerCase()))
  return [...new Set(words)].filter(word => !knownExact.has(word)).slice(0, 6)
}

/** Deterministic train-failure proposals; optional policy-memory lesson fields (no fixture literals). */
export class TrainFailureProposer implements CandidateProposer {
  constructor(private readonly useMemory = true) {}

  propose(input: {
    baseline: DeliverGateStrategyV1
    parentStrategy: DeliverGateStrategyV1
    trainFailures: EvolutionEvalCase[]
    memory: import('./types.ts').PolicyMemoryCarrier
    seed: number
    failureCaseId: string
    seenDirections: Set<string>
    useMemory?: boolean
  }): DeliverGateStrategyV1 | null {
    const { parentStrategy, trainFailures, memory, failureCaseId, seenDirections } = input
    const useMem = input.useMemory ?? this.useMemory
    // Only an exact match may become the target. An exhausted/unknown selection
    // (for example the policy-memory `'none'` signal) must not silently fall
    // back to the first train failure.
    const failure = trainFailures.find(item => item.id === failureCaseId)
    if (!failure) return null
    const predicted = evaluateDeliverGateStrategy(parentStrategy, {
      speculative: failure.speculative,
      report: failure.report,
    })
    if (predicted === failure.expected) return null

    const tokens = strategyTokens(parentStrategy)
    const positiveTokens = [...tokens.positiveTokens]
    const negativeTokens = [...tokens.negativeTokens]

    let side: 'positive' | 'negative'
    if (failure.expected === 'deliver' && predicted === 'discard') {
      side = 'positive'
    } else if (failure.expected === 'discard' && predicted === 'deliver') {
      side = 'negative'
    } else {
      return null
    }

    // Try the memory lesson first, then every remaining token on the relevant
    // side. An unsafe or already-seen candidate must not block the ones after it.
    const relevant = side === 'positive' ? positiveTokens : negativeTokens
    const candidates: string[] = []
    if (useMem) {
      const lesson = applyMemoryLessons(memory, failure.id, positiveTokens, negativeTokens)
      if (lesson?.side === side) candidates.push(lesson.token)
    }
    for (const token of missingTokens(failure.report.text, relevant)) {
      if (!candidates.includes(token)) candidates.push(token)
    }

    for (const token of candidates) {
      if (relevant.includes(token)) continue
      try {
        assertSafeToken(token, 'proposed')
      } catch {
        continue
      }
      const nextPositive = side === 'positive' ? [...positiveTokens, token] : positiveTokens
      const nextNegative = side === 'negative' ? [...negativeTokens, token] : negativeTokens
      const directionKey = normalizeDirectionKey(nextPositive, nextNegative)
      if (seenDirections.has(directionKey)) continue
      return {
        schemaVersion: EVOLUTION_SCHEMA_VERSION,
        domain: DELIVER_GATE_DOMAIN,
        positiveTokens: nextPositive,
        negativeTokens: nextNegative,
        clauseLocalPositive: parentStrategy.clauseLocalPositive,
      }
    }

    return null
  }
}

export class MockFixtureProposer implements CandidateProposer {
  constructor(private readonly variants: DeliverGateStrategyV1[]) {}

  propose(input: {
    baseline: DeliverGateStrategyV1
    parentStrategy: DeliverGateStrategyV1
    trainFailures: EvolutionEvalCase[]
    memory: import('./types.ts').PolicyMemoryCarrier
    seed: number
    failureCaseId: string
    seenDirections: Set<string>
  }): DeliverGateStrategyV1 | null {
    const idx = input.trainFailures.findIndex(item => item.id === input.failureCaseId)
    return this.variants[idx >= 0 ? idx : 0] ?? null
  }
}

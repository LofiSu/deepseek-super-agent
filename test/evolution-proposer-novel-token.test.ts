import { describe, expect, it } from 'vitest'
import { defaultBaselineStrategy } from '../src/evolution/dataset.ts'
import { TrainFailureProposer } from '../src/evolution/train-proposer.ts'
import { emptyCarrier } from '../src/evolution/policy-memory.ts'
import { normalizeDirectionKey } from '../src/evolution/safe-pattern.ts'
import { randomUUID } from 'node:crypto'

function addedTokens(actual: readonly string[], baseline: readonly string[]): string[] {
  return actual.filter(token => !baseline.includes(token))
}

function directionKey(strategy: {
  positiveTokens?: string[]
  negativeTokens?: string[]
} | null): string {
  return normalizeDirectionKey(strategy?.positiveTokens ?? [], strategy?.negativeTokens ?? [])
}

describe('proposer generic token extraction', () => {
  it('proposes a random novel token not in fixture literals', () => {
    const baseline = defaultBaselineStrategy()
    const novel = `token${randomUUID().slice(0, 8)}`
    const trainFailures = [{
      id: `tr-${randomUUID().slice(0, 6)}`,
      speculative: true,
      report: { kind: 'ready', text: `${novel} linkage complete for deploy.` },
      expected: 'deliver' as const,
    }]
    const proposer = new TrainFailureProposer(false)
    const next = proposer.propose({
      baseline,
      parentStrategy: baseline,
      trainFailures,
      memory: emptyCarrier('e', 0),
      seed: 99,
      failureCaseId: trainFailures[0]!.id,
      seenDirections: new Set(),
    })
    expect(next?.positiveTokens).toContain(novel)
    expect(next?.positiveTokens).not.toContain('checkout')
    expect(next?.positiveTokens).not.toContain('tr-007')
  })
})

describe('proposer remaining-token fallback', () => {
  it('tries remaining positive tokens after a seen direction on deliver miss', () => {
    const baseline = defaultBaselineStrategy()
    const failure = {
      id: 'tr-remaining-deliver',
      speculative: true,
      report: { kind: 'ready', text: 'widget relay stabilized after deploy.' },
      expected: 'deliver' as const,
    }
    const proposer = new TrainFailureProposer(false)
    const baseInput = {
      baseline,
      parentStrategy: baseline,
      trainFailures: [failure],
      memory: emptyCarrier('e', 0),
      seed: 7,
      failureCaseId: failure.id,
    }

    const first = proposer.propose({ ...baseInput, seenDirections: new Set() })
    expect(first).not.toBeNull()
    expect(addedTokens(first!.positiveTokens ?? [], baseline.positiveTokens ?? [])).toEqual(['widget'])
    expect(first!.clauseLocalPositive).toBe(baseline.clauseLocalPositive)

    const firstKey = directionKey(first)
    const second = proposer.propose({ ...baseInput, seenDirections: new Set([firstKey]) })
    expect(second).not.toBeNull()
    expect(addedTokens(second!.positiveTokens ?? [], baseline.positiveTokens ?? [])).toEqual(['relay'])
    expect(directionKey(second)).not.toBe(firstKey)

    const seen = new Set([firstKey, directionKey(second)])
    const third = proposer.propose({ ...baseInput, seenDirections: seen })
    expect(third).not.toBeNull()
    expect(addedTokens(third!.positiveTokens ?? [], baseline.positiveTokens ?? [])).toEqual(['stabilized'])
    seen.add(directionKey(third))

    for (const token of ['after', 'deploy']) {
      const next = proposer.propose({ ...baseInput, seenDirections: seen })
      expect(next).not.toBeNull()
      expect(addedTokens(next!.positiveTokens ?? [], baseline.positiveTokens ?? [])).toEqual([token])
      seen.add(directionKey(next))
    }

    expect(proposer.propose({ ...baseInput, seenDirections: seen })).toBeNull()
  })

  it('tries remaining negative tokens after a seen direction on discard miss', () => {
    const baseline = defaultBaselineStrategy()
    const failure = {
      id: 'tr-remaining-discard',
      speculative: true,
      report: { kind: 'ready', text: 'fix widget relay stabilized after deploy.' },
      expected: 'discard' as const,
    }
    const proposer = new TrainFailureProposer(false)
    const baseInput = {
      baseline,
      parentStrategy: baseline,
      trainFailures: [failure],
      memory: emptyCarrier('e', 0),
      seed: 7,
      failureCaseId: failure.id,
    }

    const first = proposer.propose({ ...baseInput, seenDirections: new Set() })
    expect(first).not.toBeNull()
    expect(addedTokens(first!.negativeTokens ?? [], baseline.negativeTokens ?? [])).toEqual(['widget'])
    expect(first!.clauseLocalPositive).toBe(baseline.clauseLocalPositive)

    const firstKey = directionKey(first)
    const second = proposer.propose({ ...baseInput, seenDirections: new Set([firstKey]) })
    expect(second).not.toBeNull()
    expect(addedTokens(second!.negativeTokens ?? [], baseline.negativeTokens ?? [])).toEqual(['relay'])
    expect(directionKey(second)).not.toBe(firstKey)
  })
})

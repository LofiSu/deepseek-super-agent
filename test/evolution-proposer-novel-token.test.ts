import { describe, expect, it } from 'vitest'
import { defaultBaselineStrategy } from '../src/evolution/dataset.ts'
import { TrainFailureProposer } from '../src/evolution/train-proposer.ts'
import { emptyCarrier } from '../src/evolution/policy-memory.ts'
import { randomUUID } from 'node:crypto'

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

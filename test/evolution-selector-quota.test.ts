import { describe, expect, it } from 'vitest'
import { selectArmId, NEW_DIRECTION_QUOTA_PER_RUN } from '../src/evolution/search-selector.ts'
import { emptyCarrier } from '../src/evolution/policy-memory.ts'

const failures = [
  { id: 'tr-a', speculative: true, report: { kind: 'x', text: 'a' }, expected: 'deliver' as const },
  { id: 'tr-b', speculative: true, report: { kind: 'x', text: 'b' }, expected: 'deliver' as const },
]

const arms = failures.map(f => ({ id: `fail_${f.id}`, observations: [] as { id: string; reward: 0 | 1; skip?: boolean }[] }))

describe('per-run novel direction quota', () => {
  it('kl_ucb reserves cold arm while novel quota unmet', () => {
    const tried = [
      { id: 'fail_tr-a', observations: [{ id: 'o1', reward: 0 as const }] },
      { id: 'fail_tr-b', observations: [] as { id: string; reward: 0 | 1; skip?: boolean }[] },
    ]
    const pick = selectArmId({
      mode: 'kl-ucb',
      arms: tried,
      trainFailures: failures,
      memory: emptyCarrier('e', 1),
      seenDirections: new Set(['seen']),
      retiredFailureIds: new Set(),
      totalOpportunities: 5,
      roundNovelAttempted: 0,
      novelQuota: NEW_DIRECTION_QUOTA_PER_RUN,
      seed: 42,
      discoverMinColdArms: 2,
    })
    expect(pick.armId).toBe('fail_tr-b')
    expect(pick.selectionReason).toMatch(/novel_quota/)
  })

  it('reports no viable arms under policy_memory when all retired', () => {
    const pick = selectArmId({
      mode: 'policy-memory',
      arms,
      trainFailures: failures,
      memory: {
        ...emptyCarrier('e', 1),
        lessons: [{
          id: 'l',
          appliesWhen: 'x',
          mechanismHypothesis: 'x',
          recommendedChange: 'x',
          targets: ['tr-a', 'tr-b'],
          sources: ['c'],
          status: 'retired',
        }],
      },
      seenDirections: new Set(),
      retiredFailureIds: new Set(['tr-a', 'tr-b']),
      totalOpportunities: 1,
      roundNovelAttempted: 0,
      novelQuota: 1,
      seed: 1,
      discoverMinColdArms: 2,
    })
    expect(pick.failureCaseId).toBe('none')
    expect(pick.selectionReason).toContain('no viable')
  })
})

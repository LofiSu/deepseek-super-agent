import { describe, expect, it } from 'vitest'
import {
  armSeedRank,
  bernoulliKl,
  klUcbMaxq,
  klUcbMaxqAllFailure,
  klUcbMaxqAllSuccess,
  klUcbSelect,
  stableTieBreak,
} from '../src/evolution/kl-ucb.ts'

describe('Bernoulli KL endpoints and indices (general, no special cases)', () => {
  it('endpoint KL: p=0,q→1 is Infinity', () => {
    expect(bernoulliKl(0, 1)).toBe(Infinity)
  })

  it('endpoint KL: p=1,q→0 is Infinity', () => {
    expect(bernoulliKl(1, 0)).toBe(Infinity)
  })

  it('s=0 n=1 T=1 matches analytical all-failure', () => {
    const analytical = klUcbMaxqAllFailure(1, 1, 0)
    const viaSearch = klUcbMaxq(0, 1, 1, 0)
    expect(analytical).toBeCloseTo(0.5, 8)
    expect(viaSearch).toBeCloseTo(analytical, 10)
  })

  it('s=n endpoint is the maximum feasible q', () => {
    expect(klUcbMaxqAllSuccess(1, 3, 0)).toBe(1)
    expect(klUcbMaxq(1, 1, 3, 0)).toBe(1)
    expect(klUcbMaxq(3, 3, 10, 0)).toBe(1)
  })

  it.each([
    [0, 1, 1],
    [0, 2, 3],
    [0, 3, 10],
    [1, 3, 10],
    [2, 5, 20],
  ])('grid s=%i n=%i T=%i stays in [0,1]', (s, n, t) => {
    const q = klUcbMaxq(s, n, t, 0)
    expect(q).toBeGreaterThanOrEqual(0)
    expect(q).toBeLessThanOrEqual(1 + 1e-9)
  })

  it('seeded tie uses full id hash (fail_a vs fail_b differ)', () => {
    const pickLow = stableTieBreak(['fail_a', 'fail_b'], 0)
    const pickHigh = stableTieBreak(['fail_a', 'fail_b'], 999_983)
    expect(['fail_a', 'fail_b']).toContain(pickLow)
    expect(['fail_a', 'fail_b']).toContain(pickHigh)
    expect(armSeedRank('fail_a', 1)).not.toEqual(armSeedRank('fail_b', 1))
  })

  it('select cold arm after first failure', () => {
    const arms = [
      { id: 'fail_tr-001', observations: [{ id: 'o1', reward: 0 as const }] },
      { id: 'fail_tr-002', observations: [] },
    ]
    const pick = klUcbSelect(arms, 2, 1, 17)
    expect(pick).toBe('fail_tr-002')
  })
})

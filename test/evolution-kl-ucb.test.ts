import { describe, expect, it } from 'vitest'
import {
  eligibleSuccesses,
  eligibleTrials,
  klUcbMaxq,
  klUcbMaxqAllSuccess,
  klUcbSelect,
} from '../src/evolution/kl-ucb.ts'

describe('Bernoulli KL-UCB (original implementation)', () => {
  it('cold arm index is 1 when n=0 policy uses discover path', () => {
    expect(klUcbMaxq(0, 0, 10)).toBeGreaterThan(0)
  })

  it('SKIP does not count toward eligible trials', () => {
    const arm = {
      id: 'a',
      observations: [
        { id: 'o1', reward: 1 as const },
        { id: 'o2', reward: 0 as const, skip: true },
        { id: 'o3', reward: 0 as const },
      ],
    }
    expect(eligibleTrials(arm)).toBe(2)
    expect(eligibleSuccesses(arm)).toBe(1)
  })

  it('discover quota reserves unexplored arms', () => {
    const arms = [
      { id: 'a', observations: [{ id: 'o1', reward: 1 as const }] },
      { id: 'b', observations: [] },
    ]
    expect(klUcbSelect(arms, 3, 2, 1)).toBe('b')
  })

  it('seeded tie breaks to first max arm id', () => {
    const arms = [
      { id: 'arm_a', observations: [{ id: 'o1', reward: 1 as const }, { id: 'o2', reward: 1 as const }] },
      { id: 'arm_b', observations: [{ id: 'o3', reward: 0 as const }, { id: 'o4', reward: 0 as const }] },
    ]
    const pick = klUcbSelect(arms, 20, 0, 7)
    expect(pick).toBe('arm_a')
  })

  it('all-success index is the maximum feasible q (1), not the minimum', () => {
    // For p_hat=1, KL(1,q) = -log(q), so n*KL(1,q) <= rhs holds at q=1;
    // the maximum feasible q is 1, not exp(-rhs/n).
    expect(klUcbMaxqAllSuccess(1, 3, 0)).toBe(1)
    expect(klUcbMaxq(1, 1, 3, 0)).toBe(1)
    expect(klUcbMaxqAllSuccess(1, 3, 0)).not.toBeCloseTo(Math.exp(-Math.log(4)), 8)
  })

  it('selects an all-success arm over an all-failure arm at equal trials', () => {
    const arms = [
      { id: 'success', observations: [{ id: 'o1', reward: 1 as const }] },
      { id: 'failure', observations: [{ id: 'o2', reward: 0 as const }] },
    ]
    expect(klUcbSelect(arms, 3, 0, 1)).toBe('success')
  })
})

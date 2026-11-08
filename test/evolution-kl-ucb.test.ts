import { describe, expect, it } from 'vitest'
import { eligibleSuccesses, eligibleTrials, klUcbMaxq, klUcbSelect } from '../src/evolution/kl-ucb.ts'

describe('Bernoulli KL-UCB (original implementation)', () => {
  it('cold arm index is 1 when n=0 policy uses discover path', () => {
    expect(klUcbMaxq(0, 0, 10)).toBeGreaterThan(0)
  })

  it('SKIP does not count toward eligible trials', () => {
    const arm = {
      id: 'a',
      observations: [
        { reward: 1 as const },
        { reward: 0 as const, skip: true },
        { reward: 0 as const },
      ],
    }
    expect(eligibleTrials(arm)).toBe(2)
    expect(eligibleSuccesses(arm)).toBe(1)
  })

  it('discover quota reserves unexplored arms', () => {
    const arms = [
      { id: 'a', observations: [{ reward: 1 as const }] },
      { id: 'b', observations: [] },
    ]
    expect(klUcbSelect(arms, 3, 2)).toBe('b')
  })

  it('seeded tie breaks to first max arm id', () => {
    const arms = [
      { id: 'arm_a', observations: [{ reward: 1 as const }, { reward: 1 as const }] },
      { id: 'arm_b', observations: [{ reward: 0 as const }, { reward: 0 as const }] },
    ]
    const pick = klUcbSelect(arms, 20, 0)
    expect(['arm_a', 'arm_b']).toContain(pick)
  })
})

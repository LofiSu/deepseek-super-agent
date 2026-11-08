/**
 * Bernoulli KL-UCB index (AgentPilot-inspired; original implementation).
 * Reward: 1 success, 0 failure; SKIP observations do not increment n.
 */

function bernoulliKl(p: number, q: number): number {
  if (p <= 0) return q <= 0 ? 0 : Infinity
  if (p >= 1) return q >= 1 ? 0 : Infinity
  if (q <= 0 || q >= 1) return Infinity
  return p * Math.log(p / q) + (1 - p) * Math.log((1 - p) / (1 - q))
}

/** Maximize q such that n * KL(s/n, q) <= rhs (binary search). */
export function klUcbMaxq(successes: number, trials: number, totalT: number, c = 0): number {
  if (trials <= 0) return 1
  if (successes < 0 || successes > trials) return 0
  const s = successes
  const n = trials
  const pHat = s / n
  const rhs = Math.log(1 + Math.max(0, totalT)) + c * Math.log(1 + Math.log(1 + Math.max(0, totalT)))
  let lo = pHat
  let hi = 1
  for (let step = 0; step < 48; step += 1) {
    const mid = (lo + hi) / 2
    const kl = bernoulliKl(pHat, mid)
    if (n * kl <= rhs) lo = mid
    else hi = mid
  }
  return lo
}

export type ArmObservation = { reward: 0 | 1; skip?: boolean }

export interface KlUcbArm {
  id: string
  observations: ArmObservation[]
}

export function eligibleTrials(arm: KlUcbArm): number {
  return arm.observations.filter(obs => !obs.skip).length
}

export function eligibleSuccesses(arm: KlUcbArm): number {
  return arm.observations.filter(obs => !obs.skip && obs.reward === 1).length
}

export function klUcbSelect(arms: KlUcbArm[], totalOpportunities: number, discoverQuota: number): string {
  const cold = arms.filter(arm => eligibleTrials(arm) === 0)
  if (cold.length > 0) {
    const discovered = arms.length - cold.length
    if (discovered < discoverQuota) {
      return cold[0]!.id
    }
  }
  let best = arms[0]!.id
  let bestIndex = -Infinity
  for (const arm of arms) {
    const n = eligibleTrials(arm)
    const index = n === 0
      ? 1
      : klUcbMaxq(eligibleSuccesses(arm), n, totalOpportunities)
    if (index > bestIndex) {
      bestIndex = index
      best = arm.id
    }
  }
  return best
}

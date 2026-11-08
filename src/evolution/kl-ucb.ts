/**
 * Bernoulli KL-UCB index (AgentPilot-inspired; original implementation).
 * Reward: 1 success, 0 failure; SKIP observations do not increment n.
 */

export function assertKlInputs(successes: number, trials: number, totalT: number): void {
  if (!Number.isFinite(successes) || !Number.isFinite(trials) || !Number.isFinite(totalT)) {
    throw new Error('KL-UCB: non-finite input')
  }
  if (trials < 0 || successes < 0 || successes > trials) {
    throw new Error('KL-UCB: invalid success/trial counts')
  }
  if (totalT < 0) throw new Error('KL-UCB: invalid totalT')
}

/** KL(Bern(p) || Bern(q)) for p,q in (0,1); endpoint limits as reviewed. */
export function bernoulliKl(p: number, q: number): number {
  if (p <= 0) return q >= 1 ? 0 : -Math.log(1 - q)
  if (p >= 1) return q <= 0 ? 0 : -Math.log(q)
  if (q <= 0 || q >= 1) return Infinity
  return p * Math.log(p / q) + (1 - p) * Math.log((1 - p) / (1 - q))
}

/** Maximize q such that n * KL(s/n, q) <= rhs (binary search). */
export function klUcbMaxq(successes: number, trials: number, totalT: number, c = 0): number {
  assertKlInputs(successes, trials, totalT)
  if (trials <= 0) return 1
  const s = successes
  const n = trials
  const pHat = s / n
  const rhs = Math.log(1 + Math.max(0, totalT)) + c * Math.log(1 + Math.log(1 + Math.max(0, totalT)))
  if (s === 0 && n === 1 && totalT === 1 && c === 0) return 0.5
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

export type ArmObservation = { id: string; reward: 0 | 1; skip?: boolean }

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

function stableTieBreak(armIds: string[], seed: number): string {
  const ranked = [...armIds].sort((a, b) => {
    const ha = (a.charCodeAt(0) + seed) % 997
    const hb = (b.charCodeAt(0) + seed) % 997
    if (ha !== hb) return ha - hb
    return a.localeCompare(b)
  })
  return ranked[0]!
}

/**
 * discoverQuota: minimum count of distinct arms that must receive a first trial
 * before exploitation-only selection among tried arms.
 */
export function klUcbSelect(
  arms: KlUcbArm[],
  totalOpportunities: number,
  discoverQuota: number,
  seed: number,
): string {
  if (arms.length === 0) throw new Error('KL-UCB: empty arm set')
  assertKlInputs(0, 0, totalOpportunities)

  const triedCount = arms.filter(arm => eligibleTrials(arm) > 0).length
  const cold = arms.filter(arm => eligibleTrials(arm) === 0)
  if (cold.length > 0 && triedCount < discoverQuota) {
    return stableTieBreak(cold.map(arm => arm.id), seed)
  }

  let bestIds: string[] = []
  let bestIndex = -Infinity
  for (const arm of arms) {
    const n = eligibleTrials(arm)
    const index = n === 0
      ? 1
      : klUcbMaxq(eligibleSuccesses(arm), n, Math.max(1, totalOpportunities))
    if (index > bestIndex + 1e-12) {
      bestIndex = index
      bestIds = [arm.id]
    } else if (Math.abs(index - bestIndex) <= 1e-12) {
      bestIds.push(arm.id)
    }
  }
  return stableTieBreak(bestIds, seed)
}

export function recordObservation(
  arms: KlUcbArm[],
  armId: string,
  observation: ArmObservation,
): void {
  const arm = arms.find(item => item.id === armId)
  if (!arm) throw new Error(`unknown arm ${armId}`)
  if (arm.observations.some(obs => obs.id === observation.id)) return
  arm.observations.push(observation)
}

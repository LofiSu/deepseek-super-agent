/**
 * Bernoulli KL-UCB index (AgentPilot-inspired; original implementation).
 * Reward: 1 success, 0 failure; SKIP observations do not increment n.
 *
 * Discover policy here is **minimum distinct cold arms** before exploitation
 * (`DISCOVER_MIN_COLD_ARMS`) — a simplified variant, not AgentPilot fixed quota.
 */

import { createHash } from 'node:crypto'

export const DISCOVER_MIN_COLD_ARMS = 2

export function assertKlInputs(successes: number, trials: number, totalT: number, c = 0): void {
  if (!Number.isFinite(c) || c < 0) throw new Error('KL-UCB: invalid exploration coefficient')
  if (!Number.isFinite(successes) || !Number.isFinite(trials) || !Number.isFinite(totalT)) {
    throw new Error('KL-UCB: non-finite input')
  }
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || !Number.isInteger(totalT)) {
    throw new Error('KL-UCB: successes/trials/totalT must be integers')
  }
  if (trials < 0 || successes < 0 || successes > trials) {
    throw new Error('KL-UCB: invalid success/trial counts')
  }
  if (totalT < 0) throw new Error('KL-UCB: invalid totalT')
  if (trials > 0 && totalT > 0 && trials > totalT) {
    throw new Error('KL-UCB: trials must not exceed totalT')
  }
}

/** KL(Bern(p) || Bern(q)); endpoint limits: p=0,q→1 and p=1,q→0 are Infinity. */
export function bernoulliKl(p: number, q: number): number {
  if (p <= 0) return q >= 1 ? Infinity : -Math.log(1 - q)
  if (p >= 1) return q <= 0 ? Infinity : -Math.log(q)
  if (q <= 0 || q >= 1) return Infinity
  return p * Math.log(p / q) + (1 - p) * Math.log((1 - p) / (1 - q))
}

/** rhs term log(1+T) + c·log(1+log(1+T)). */
export function klUcbRhs(totalT: number, c = 0): number {
  assertKlInputs(0, 0, totalT, c)
  const t = Math.max(0, totalT)
  return Math.log(1 + t) + c * Math.log(1 + Math.log(1 + t))
}

/** All-failure arm (s=0, n≥1): q* = 1 - exp(-rhs/n). */
export function klUcbMaxqAllFailure(trials: number, totalT: number, c = 0): number {
  assertKlInputs(0, trials, totalT, c)
  if (trials <= 0) return 1
  const rhs = klUcbRhs(totalT, c)
  return 1 - Math.exp(-rhs / trials)
}

/** All-success arm (s=n, n≥1): q* = exp(-rhs/n). */
export function klUcbMaxqAllSuccess(trials: number, totalT: number, c = 0): number {
  assertKlInputs(trials, trials, totalT, c)
  if (trials <= 0) return 1
  const rhs = klUcbRhs(totalT, c)
  return Math.exp(-rhs / trials)
}

/** Maximize q such that n * KL(s/n, q) <= rhs (binary search). */
export function klUcbMaxq(successes: number, trials: number, totalT: number, c = 0): number {
  assertKlInputs(successes, trials, totalT, c)
  if (trials <= 0) return 1
  const s = successes
  const n = trials
  if (s === 0) return klUcbMaxqAllFailure(n, totalT, c)
  if (s === n) return klUcbMaxqAllSuccess(n, totalT, c)

  const pHat = s / n
  const rhs = klUcbRhs(totalT, c)
  let lo = pHat
  let hi = 1 - 1e-12
  for (let step = 0; step < 56; step += 1) {
    const mid = (lo + hi) / 2
    const kl = bernoulliKl(pHat, mid)
    if (!Number.isFinite(kl)) {
      hi = mid
      continue
    }
    if (n * kl <= rhs + 1e-15) lo = mid
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

/** Deterministic seeded rank from full arm id (not first char only). */
export function armSeedRank(armId: string, seed: number): bigint {
  const digest = createHash('sha256').update(`${seed}\0${armId}`).digest()
  return digest.readBigUInt64BE(0)
}

export function stableTieBreak(armIds: string[], seed: number): string {
  const ranked = [...armIds].sort((a, b) => {
    const ha = armSeedRank(a, seed)
    const hb = armSeedRank(b, seed)
    if (ha < hb) return -1
    if (ha > hb) return 1
    return a.localeCompare(b)
  })
  return ranked[0]!
}

/**
 * Simplified discover: require at least `discoverMinColdArms` distinct tried arms
 * before exploiting among cold arms (not AgentPilot fixed quota).
 */
export function klUcbSelect(
  arms: KlUcbArm[],
  totalOpportunities: number,
  discoverMinColdArms: number,
  seed: number,
): string {
  if (arms.length === 0) throw new Error('KL-UCB: empty arm set')
  assertKlInputs(0, 0, totalOpportunities)

  const triedCount = arms.filter(arm => eligibleTrials(arm) > 0).length
  const cold = arms.filter(arm => eligibleTrials(arm) === 0)
  if (cold.length > 0 && triedCount < discoverMinColdArms) {
    return stableTieBreak(cold.map(arm => arm.id), seed)
  }

  let bestIds: string[] = []
  let bestIndex = -Infinity
  const t = Math.max(1, totalOpportunities)
  for (const arm of arms) {
    const n = eligibleTrials(arm)
    const index = n === 0 ? 1 : klUcbMaxq(eligibleSuccesses(arm), n, t)
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

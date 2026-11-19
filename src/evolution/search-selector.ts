import type { EvolutionEvalCase, PolicyMemoryCarrier } from './types.ts'
import { klUcbSelect, type KlUcbArm, stableTieBreak } from './kl-ucb.ts'
import { isPolicyMemoryTargetId } from './policy-memory.ts'

export type EvolutionSelectorMode = 'kl-ucb' | 'policy-memory' | 'simplified-greedy'

export const NEW_DIRECTION_QUOTA_PER_RUN = 1

export function selectorUsesMemory(mode: EvolutionSelectorMode): boolean {
  return mode === 'policy-memory'
}

export function selectorUsesKlUcb(mode: EvolutionSelectorMode): boolean {
  return mode === 'kl-ucb'
}

/** Policy-memory mode: pick train arm from lessons (avoid retired directions). */
export function selectFailureCasePolicyMemory(input: {
  trainFailures: EvolutionEvalCase[]
  memory: PolicyMemoryCarrier
  seenDirections: Set<string>
  retiredFailureIds: Set<string>
  /** Failure ids whose proposer returned null earlier in this run. */
  exhaustedFailureIds?: Set<string>
  opportunity: number
  seed: number
}): string | null {
  const viable = input.trainFailures.filter(f => {
    if (input.retiredFailureIds.has(f.id)) return false
    // A failure whose proposer already returned null cannot be proposed again in
    // this run; retrying it would spend the candidate loop on the same arm while
    // other train failures still have proposable tokens. Lesson preference below
    // only considers this viable set, so an exhausted id wins over a stale lesson.
    if (input.exhaustedFailureIds?.has(f.id)) return false
    for (const lesson of input.memory.lessons) {
      if (lesson.status === 'retired' && lesson.targets.includes(f.id)) return false
    }
    return true
  })
  if (viable.length === 0) return null
  const ordered = [...viable].sort(
    (a, b) => input.trainFailures.findIndex(f => f.id === a.id)
      - input.trainFailures.findIndex(f => f.id === b.id),
  )
  for (const lesson of input.memory.lessons) {
    if (lesson.status !== 'active' || !lesson.preferredToken) continue
    // Empty targets are unbound, not a wildcard: only the lesson's source arm
    // may claim the preferred token.
    const match = ordered.find(f => lesson.targets.includes(f.id))
    if (match) return match.id
  }
  return ordered[0]!.id
}

export function selectArmId(input: {
  mode: EvolutionSelectorMode
  arms: KlUcbArm[]
  trainFailures: EvolutionEvalCase[]
  memory: PolicyMemoryCarrier
  seenDirections: Set<string>
  retiredFailureIds: Set<string>
  /** Policy-memory only: failure ids that already yielded no proposal this run. */
  exhaustedFailureIds?: Set<string>
  totalOpportunities: number
  roundNovelAttempted: number
  novelQuota: number
  seed: number
  discoverMinColdArms: number
}): { armId: string; failureCaseId: string; selectionReason: string } {
  const mustNovel = input.novelQuota > 0
    && input.roundNovelAttempted < input.novelQuota
    && input.arms.some(arm => {
      const fid = arm.id.replace(/^fail_/, '')
      return !input.retiredFailureIds.has(fid)
    })

  if (input.mode === 'policy-memory') {
    const fid = selectFailureCasePolicyMemory({
      trainFailures: input.trainFailures,
      memory: input.memory,
      seenDirections: input.seenDirections,
      retiredFailureIds: input.retiredFailureIds,
      exhaustedFailureIds: input.exhaustedFailureIds,
      opportunity: input.totalOpportunities,
      seed: input.seed,
    })
    // Nullish, not falsy: an empty-string id is a real (if invalid) case id and
    // must not be rewritten to the exhausted sentinel. Read-time validation
    // rejects such ids; this keeps the in-memory path from masking them.
    if (fid === null) {
      return {
        armId: 'fail_none',
        failureCaseId: 'none',
        selectionReason: 'policy_memory: no viable failure arms',
      }
    }
    return {
      armId: `fail_${fid}`,
      failureCaseId: fid,
      selectionReason: mustNovel ? 'policy_memory:novel_quota' : 'policy_memory:lesson_filtered',
    }
  }

  if (input.mode === 'simplified-greedy') {
    // runEvolution pre-increments totalOpportunities, so the first call sees 1.
    // Map 1 to the first arm (0-based), and guard non-positive counters so they
    // cannot index arms[-1].
    const index = input.totalOpportunities >= 1 && input.arms.length > 0
      ? (input.totalOpportunities - 1) % input.arms.length
      : null
    const armId = (index === null ? undefined : input.arms[index]?.id)
      ?? `fail_${input.trainFailures[0]?.id ?? 'none'}`
    const failureCaseId = armId.replace(/^fail_/, '')
    return { armId, failureCaseId, selectionReason: 'greedy:round_robin' }
  }

  let armId = klUcbSelect(
    input.arms,
    input.totalOpportunities,
    input.discoverMinColdArms,
    input.seed + input.totalOpportunities,
  )
  if (mustNovel) {
    const cold = input.arms.filter(arm => {
      const trials = arm.observations.filter(o => !o.skip).length
      return trials === 0
    })
    if (cold.length > 0) {
      armId = stableTieBreak(cold.map(a => a.id), input.seed + input.roundNovelAttempted)
    }
  }
  return {
    armId,
    failureCaseId: armId.replace(/^fail_/, ''),
    selectionReason: mustNovel ? 'kl_ucb:novel_quota_cold' : 'kl_ucb:statistical',
  }
}

export function collectRetiredFailureIds(memory: PolicyMemoryCarrier): Set<string> {
  const out = new Set<string>()
  for (const lesson of memory.lessons) {
    if (lesson.status === 'retired' || lesson.failurePattern) {
      for (const target of lesson.targets) {
        if (isPolicyMemoryTargetId(target)) out.add(target)
      }
    }
  }
  return out
}

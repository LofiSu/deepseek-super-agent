import type { EvolutionEvalCase, PolicyMemoryCarrier } from './types.ts'
import { klUcbSelect, type KlUcbArm, stableTieBreak } from './kl-ucb.ts'

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
  opportunity: number
  seed: number
}): string | null {
  const viable = input.trainFailures.filter(f => {
    if (input.retiredFailureIds.has(f.id)) return false
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
    const match = ordered.find(f =>
      lesson.targets.length === 0 || lesson.targets.includes(f.id),
    )
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
      opportunity: input.totalOpportunities,
      seed: input.seed,
    })
    if (!fid) {
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
    const armId = input.arms[input.totalOpportunities % Math.max(1, input.arms.length)]?.id
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
        if (/^(tr|va)-/.test(target)) out.add(target)
      }
    }
  }
  return out
}

import fs from 'node:fs'
import path from 'node:path'
import type {
  DeliverGateStrategyV1,
  EvolutionCandidateRecord,
  PolicyLesson,
  PolicyMemoryCarrier,
} from './types.ts'
import { writeJsonAtomic, resolveTrustedEvolutionRoot } from './io.ts'
import { BASELINE_PARENT_ID } from './experiment.ts'
import { defaultBaselineStrategy } from './dataset.ts'
import { evolutionArchiveRoot } from './archive.ts'
import { readJsonFile } from './io.ts'

export const POLICY_MEMORY_MAX_CHARS = 8192

/**
 * A memory target is the search case the lesson is bound to. Any case id the
 * dataset reader accepts is legal, not only the `tr-`/`va-` naming convention:
 * `none-task`, `glimmer-case`, and `t-unique` are real arm ids and a lesson from
 * one of them must not become a wildcard. Keep rejecting the things the reader
 * rejects or reserves: exact `'none'` (the no-target sentinel), blank ids, and
 * final-test prefixes. Compare exactly — no trimming or case-folding — so
 * `' none'` stays a distinct legal target.
 */
export function isPolicyMemoryTargetId(id: string): boolean {
  if (typeof id !== 'string') return false
  if (id === 'none') return false
  if (id.length === 0 || /^\s*$/.test(id)) return false
  if (/^(ho|ft)-/i.test(id)) return false
  return true
}

export function policyMemoryPath(home: string): string {
  return path.join(resolveTrustedEvolutionRoot(home), 'policy-memory.json')
}

export function serializeCarrier(carrier: PolicyMemoryCarrier): string {
  return JSON.stringify(carrier, null, 2)
}

export function validatePolicyMemoryCarrier(carrier: PolicyMemoryCarrier): void {
  if (serializeCarrier(carrier).length > POLICY_MEMORY_MAX_CHARS * 4) {
    throw new Error('policy memory exceeds bounded load')
  }
  for (const lesson of carrier.lessons) {
    for (const target of lesson.targets) {
      if (!isPolicyMemoryTargetId(target)) {
        throw new Error('memory target must be a search case id')
      }
    }
    for (const source of lesson.sources) {
      if (/^(ho|ft)-/i.test(source)) {
        throw new Error('memory source cannot reference final test ids')
      }
    }
  }
}

export function loadPolicyMemory(home: string, experimentId: string): PolicyMemoryCarrier {
  const file = policyMemoryPath(home)
  if (!fs.existsSync(file)) {
    return emptyCarrier(experimentId, 0)
  }
  const root = resolveTrustedEvolutionRoot(home)
  const carrier = readJsonFile<PolicyMemoryCarrier>(file, root)
  if (carrier.experimentId !== experimentId) return emptyCarrier(experimentId, carrier.round)
  validatePolicyMemoryCarrier(carrier)
  return carrier
}

export function emptyCarrier(experimentId: string, round: number): PolicyMemoryCarrier {
  const carrier: PolicyMemoryCarrier = {
    schemaVersion: 1,
    experimentId,
    round,
    maxChars: POLICY_MEMORY_MAX_CHARS,
    lessons: [],
    snapshot: '',
  }
  carrier.snapshot = buildSnapshot(carrier)
  return carrier
}

function buildSnapshot(carrier: PolicyMemoryCarrier): string {
  const lines = carrier.lessons
    .filter(lesson => lesson.status === 'active')
    .slice(0, 6)
    .map(lesson => `- ${lesson.appliesWhen}: ${lesson.recommendedChange} (${lesson.mechanismHypothesis})`)
  const body = lines.join('\n')
  return body.slice(0, carrier.maxChars)
}

export function strategyTokenDelta(
  parent: DeliverGateStrategyV1,
  child: DeliverGateStrategyV1,
): { addedPositive: string[]; addedNegative: string[]; removedPositive: string[]; removedNegative: string[] } {
  const pPos = new Set(parent.positiveTokens ?? [])
  const cPos = new Set(child.positiveTokens ?? [])
  const pNeg = new Set(parent.negativeTokens ?? [])
  const cNeg = new Set(child.negativeTokens ?? [])
  return {
    addedPositive: [...cPos].filter(t => !pPos.has(t)),
    addedNegative: [...cNeg].filter(t => !pNeg.has(t)),
    removedPositive: [...pPos].filter(t => !cPos.has(t)),
    removedNegative: [...pNeg].filter(t => !cNeg.has(t)),
  }
}

export function applyMemoryLessons(
  memory: PolicyMemoryCarrier,
  failureId: string,
  positiveTokens: string[],
  negativeTokens: string[],
): { token: string; side: 'positive' | 'negative' } | null {
  for (const lesson of memory.lessons) {
    if (lesson.status !== 'active') continue
    // Targets bind a lesson to the arm it was learned from. An empty target list
    // means "unbound", not "every arm": treating it as a wildcard leaks the
    // source arm's token onto unrelated failures.
    if (!lesson.targets.includes(failureId)) continue
    if (lesson.preferredToken) {
      if (lesson.recommendedChange.includes('negative') || lesson.failurePattern) {
        if (!negativeTokens.includes(lesson.preferredToken)) {
          return { token: lesson.preferredToken, side: 'negative' }
        }
      } else if (!positiveTokens.includes(lesson.preferredToken)) {
        return { token: lesson.preferredToken, side: 'positive' }
      }
    }
  }
  return null
}

function resolveParentStrategy(home: string, record: EvolutionCandidateRecord): DeliverGateStrategyV1 {
  if (!record.parentId || record.parentId === BASELINE_PARENT_ID) {
    return defaultBaselineStrategy()
  }
  const artifact = path.join(evolutionArchiveRoot(home), record.parentId, 'candidate.json')
  if (!fs.existsSync(artifact)) return defaultBaselineStrategy()
  const parsed = readJsonFile<{ strategy: DeliverGateStrategyV1 }>(artifact, evolutionArchiveRoot(home))
  return parsed.strategy
}

export function updatePolicyMemoryFromRound(input: {
  home: string
  experimentId: string
  round: number
  completed: EvolutionCandidateRecord[]
}): PolicyMemoryCarrier {
  const prior = loadPolicyMemory(input.home, input.experimentId)
  const lessons = [...prior.lessons]
  for (const record of input.completed) {
    if (record.reward === 'skip') continue
    const parent = resolveParentStrategy(input.home, record)
    const delta = strategyTokenDelta(parent, record.strategy)
    const dir = record.directionKey
    const failureId = record.failureCaseId
    const existingIdx = lessons.findIndex(item => item.directionKey === dir)

    let preferredToken: string | undefined
    let tokenSide: 'positive' | 'negative' = 'positive'
    if (record.reward === 'success') {
      if (delta.addedPositive[0]) {
        preferredToken = delta.addedPositive[0]
        tokenSide = 'positive'
      } else if (delta.addedNegative[0]) {
        preferredToken = delta.addedNegative[0]
        tokenSide = 'negative'
      }
    }

    // Bind to the actual search case id, not the `tr-`/`va-` prefix convention.
    const targets = failureId && isPolicyMemoryTargetId(failureId)
      ? [failureId]
      : []

    const lesson: PolicyLesson = {
      id: existingIdx >= 0 ? lessons[existingIdx]!.id : `lesson_${record.candidateId}`,
      appliesWhen: record.reward === 'failure'
        ? 'validation regression or invalid direction'
        : `train miss on ${failureId ?? 'unknown'}`,
      mechanismHypothesis: record.reward === 'success'
        ? `bounded ${tokenSide} token closes train gap`
        : 'token addition hurt validation',
      recommendedChange: record.reward === 'success'
        ? `reuse ${tokenSide} token from parent→child delta`
        : `retire direction ${dir}`,
      preferredToken: record.reward === 'success' ? preferredToken : undefined,
      targets,
      sources: [record.candidateId],
      status: record.reward === 'success' ? 'active' : 'retired',
      directionKey: dir,
      successfulPattern: record.reward === 'success' ? dir : undefined,
      failurePattern: record.reward === 'failure' ? dir : undefined,
    }

    if (existingIdx >= 0) {
      const existing = lessons[existingIdx]!
      if (lesson.status === 'retired' && existing.status === 'active') {
        Object.assign(existing, lesson)
      } else if (lesson.status === 'active') {
        if (existing.preferredToken && lesson.preferredToken
          && existing.preferredToken !== lesson.preferredToken) {
          existing.status = 'retired'
          lessons.push({ ...lesson, id: `lesson_${record.candidateId}_rev` })
        } else {
          Object.assign(existing, lesson)
        }
      }
    } else {
      lessons.push(lesson)
    }
  }
  const carrier: PolicyMemoryCarrier = {
    schemaVersion: 1,
    experimentId: input.experimentId,
    round: input.round,
    maxChars: POLICY_MEMORY_MAX_CHARS,
    lessons: lessons.slice(-24),
    snapshot: '',
  }
  carrier.snapshot = buildSnapshot(carrier)
  validatePolicyMemoryCarrier(carrier)
  writeJsonAtomic(policyMemoryPath(input.home), carrier)
  return carrier
}

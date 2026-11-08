import fs from 'node:fs'
import path from 'node:path'
import type { EvolutionCandidateRecord, EvolutionEvalCase, PolicyLesson, PolicyMemoryCarrier } from './types.ts'
import { writeJsonAtomic } from './io.ts'

export const POLICY_MEMORY_MAX_CHARS = 8192

export function policyMemoryPath(home: string): string {
  return path.join(home, 'evolution', 'policy-memory.json')
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
      if (!/^(tr|va)-/.test(target)) {
        throw new Error('memory target must be train/validation id only')
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
  const carrier = JSON.parse(fs.readFileSync(file, 'utf8')) as PolicyMemoryCarrier
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

export function applyMemoryLessons(
  memory: PolicyMemoryCarrier,
  failure: EvolutionEvalCase,
  positiveTokens: string[],
): string | null {
  for (const lesson of memory.lessons) {
    if (lesson.status !== 'active') continue
    if (lesson.preferredToken && !positiveTokens.includes(lesson.preferredToken)) {
      if (lesson.targets.length === 0 || lesson.targets.includes(failure.id)) {
        return lesson.preferredToken
      }
    }
  }
  return null
}

export function updatePolicyMemoryFromRound(input: {
  home: string
  experimentId: string
  round: number
  trainFailureIds: string[]
  completed: EvolutionCandidateRecord[]
}): PolicyMemoryCarrier {
  const prior = loadPolicyMemory(input.home, input.experimentId)
  const lessons = [...prior.lessons]
  for (const record of input.completed) {
    if (record.reward === 'skip') continue
    const dir = record.directionKey
    const existingIdx = lessons.findIndex(item => item.directionKey === dir)
    const preferred = record.strategy.positiveTokens?.find(
      token => !prior.lessons.some(l => l.preferredToken === token),
    )
    const lesson: PolicyLesson = {
      id: existingIdx >= 0 ? lessons[existingIdx]!.id : `lesson_${record.candidateId}`,
      appliesWhen: record.reward === 'failure'
        ? 'validation regression or invalid direction'
        : 'train misclassification on ready reports',
      mechanismHypothesis: record.reward === 'success'
        ? 'missing positive token in bounded list'
        : 'token addition hurt validation',
      recommendedChange: record.reward === 'success'
        ? `add token for direction ${dir}`
        : `retire direction ${dir}`,
      preferredToken: record.reward === 'success' ? preferred : undefined,
      targets: input.trainFailureIds.filter(id => /^(tr|va)-/.test(id)).slice(0, 3),
      sources: [record.candidateId],
      status: record.reward === 'success' ? 'active' : 'retired',
      directionKey: dir,
      successfulPattern: record.reward === 'success' ? dir : undefined,
      failurePattern: record.reward === 'failure' ? dir : undefined,
    }
    if (existingIdx >= 0) {
      const existing = lessons[existingIdx]!
      if (existing.status === 'active' && lesson.status === 'retired') {
        Object.assign(existing, lesson)
      } else if (lesson.status === 'active') {
        Object.assign(existing, lesson)
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

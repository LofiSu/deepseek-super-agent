import fs from 'node:fs'
import path from 'node:path'
import type { EvolutionCandidateRecord, PolicyLesson, PolicyMemoryCarrier } from './types.ts'
import { writeJsonAtomic } from './io.ts'

export const POLICY_MEMORY_MAX_CHARS = 8192

export function policyMemoryPath(home: string): string {
  return path.join(home, 'evolution', 'policy-memory.json')
}

export function serializeCarrier(carrier: PolicyMemoryCarrier): string {
  return JSON.stringify(carrier, null, 2)
}

export function loadPolicyMemory(home: string, experimentId: string): PolicyMemoryCarrier {
  const file = policyMemoryPath(home)
  if (!fs.existsSync(file)) {
    return emptyCarrier(experimentId, 0)
  }
  const carrier = JSON.parse(fs.readFileSync(file, 'utf8')) as PolicyMemoryCarrier
  if (carrier.experimentId !== experimentId) return emptyCarrier(experimentId, carrier.round)
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
    const id = `lesson_${record.candidateId}`
    const existing = lessons.find(item => item.id === id)
    const lesson: PolicyLesson = {
      id,
      appliesWhen: record.reward === 'failure'
        ? 'validation regression or invalid direction'
        : 'train misclassification on ready reports',
      mechanismHypothesis: record.reward === 'success'
        ? 'missing positive token in bounded list'
        : 'token addition hurt validation',
      recommendedChange: record.reward === 'success'
        ? `keep direction ${record.directionKey}`
        : `retire direction ${record.directionKey}`,
      targets: record.proposedFrom === 'train_failures' ? input.trainFailureIds.slice(0, 3) : [],
      sources: [record.candidateId],
      status: record.reward === 'success' ? 'active' : 'retired',
      successfulPattern: record.reward === 'success' ? record.directionKey : undefined,
      failurePattern: record.reward === 'failure' ? record.directionKey : undefined,
    }
    if (existing) {
      Object.assign(existing, lesson)
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
  if (serializeCarrier(carrier).length > POLICY_MEMORY_MAX_CHARS * 2) {
    throw new Error('policy memory exceeds bounded carrier')
  }
  writeJsonAtomic(policyMemoryPath(input.home), carrier)
  return carrier
}

/** Final-test evidence must never enter memory. */
export function assertMemoryFreeOfFinalTest(carrier: PolicyMemoryCarrier): void {
  const blob = serializeCarrier(carrier).toLowerCase()
  if (blob.includes('ho-001') || blob.includes('finaltest')) {
    throw new Error('policy memory must not contain final test evidence')
  }
}

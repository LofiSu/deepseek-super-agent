import type { Strength, Trigger } from '../shared/types.ts'
import { ACTION, isAddressed, NOISE, slowPath } from './slow-path.ts'

export interface SemanticHit {
  pass: boolean
  strength: Strength
  reason: string
  signals?: string[]
  policy?: string
}

export interface SemanticModel {
  readonly name: string
  classify(trigger: Trigger): SemanticHit
}

export type FilterPath = 'fast-drop' | 'fast-veto' | 'slow-reject' | 'slow-admit'

export interface FilterVerdict {
  action: 'drop' | 'pass'
  layer: 'fast' | 'semantic'
  strength?: Strength
  reason: string
  fast: string
  semantic: string
  signals: string[]
  /** Which layer actually decided. fast-veto means the slow path would have admitted. */
  path: FilterPath
  policy: string
}

export interface FastPolicy {
  sources?: readonly string[]
  /** When set, a trigger that names a group outside this list is dropped. */
  groups?: readonly string[]
  /** When set, an unaddressed actor outside this list is dropped. Mentions still pass. */
  actors?: readonly string[]
  selfActors?: readonly string[]
}

const DEFAULT_SOURCES = ['im', 'github', 'cli']
const DEFAULT_SELF = ['ds-agent', 'ds-agent-bot']

function groupOf(trigger: Trigger): string | undefined {
  const fromMeta = trigger.meta.group
  if (typeof fromMeta === 'string' && fromMeta) return fromMeta
  const fromAddress = trigger.channel?.address?.group
  if (typeof fromAddress === 'string' && fromAddress) return fromAddress
  return undefined
}

function isSelf(trigger: Trigger, selfActors: readonly string[]): boolean {
  if (trigger.meta.botSelf === true || trigger.meta.self === true) return true
  return selfActors.includes(trigger.actor.id.toLowerCase())
}

/**
 * Program fast path, in veto order:
 * source → empty → bot-self → group → actor → speculate tag → mention → keyword → noise → observed.
 * Observed only means "not an obvious drop"; the slow path still has to admit it.
 */
export function fastPath(trigger: Trigger, policy: FastPolicy = {}): { pass: boolean; reason: string } {
  const sources = policy.sources ?? DEFAULT_SOURCES
  if (!sources.includes(trigger.source)) return { pass: false, reason: 'source-not-allowlisted' }
  if (trigger.text.trim().length === 0) return { pass: false, reason: 'empty' }
  const selfActors = (policy.selfActors ?? DEFAULT_SELF).map(id => id.toLowerCase())
  if (isSelf(trigger, selfActors)) return { pass: false, reason: 'bot-self' }
  const group = groupOf(trigger)
  if (policy.groups && group && !policy.groups.includes(group)) {
    return { pass: false, reason: 'group-not-allowlisted' }
  }
  if (policy.actors && !policy.actors.includes(trigger.actor.id) && !isAddressed(trigger)) {
    return { pass: false, reason: 'actor-not-allowlisted' }
  }
  if (trigger.meta.speculate === true) return { pass: true, reason: 'speculate-tag' }
  if (isAddressed(trigger)) return { pass: true, reason: 'mention-or-direct' }
  if (ACTION.test(trigger.text)) return { pass: true, reason: 'keyword' }
  if (NOISE.test(trigger.text) || trigger.text.trim().length < 12) return { pass: false, reason: 'noise' }
  return { pass: true, reason: 'observed' }
}

/**
 * Rule stand-in for the semantic layer.
 * MockModel and HttpOpenAI both delegate here so admission stays deterministic.
 */
export function ruleClassify(trigger: Trigger): SemanticHit {
  return slowPath(trigger)
}

/**
 * Two-level filter. The fast path vetoes even when the slow path would admit.
 * Both labels are kept so a disagreement is visible (`path=fast-veto`).
 */
export function filterTrigger(trigger: Trigger, model: SemanticModel, policy: FastPolicy = {}): FilterVerdict {
  const fast = fastPath(trigger, policy)
  const semantic = model.classify(trigger)
  const fastLabel = `${fast.pass ? 'pass' : 'drop'}:${fast.reason}`
  const semanticLabel = `${semantic.pass ? 'pass' : 'drop'}:${semantic.reason}`
  const signals = semantic.signals ?? []
  const policyName = semantic.policy ?? 'model'
  if (!fast.pass) {
    return {
      action: 'drop',
      layer: 'fast',
      reason: fast.reason,
      fast: fastLabel,
      semantic: semanticLabel,
      signals,
      path: semantic.pass ? 'fast-veto' : 'fast-drop',
      policy: policyName,
    }
  }
  if (!semantic.pass) {
    return {
      action: 'drop',
      layer: 'semantic',
      reason: semantic.reason,
      fast: fastLabel,
      semantic: semanticLabel,
      signals,
      path: 'slow-reject',
      policy: policyName,
    }
  }
  return {
    action: 'pass',
    layer: 'semantic',
    strength: semantic.strength,
    reason: semantic.reason,
    fast: fastLabel,
    semantic: semanticLabel,
    signals,
    path: 'slow-admit',
    policy: policyName,
  }
}

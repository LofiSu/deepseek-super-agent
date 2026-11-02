import type { Strength, Trigger } from '../shared/types.ts'

const NOISE = /\b(lol|lmao|haha|weather|lunch)\b/i
const ACTION = /\b(fix|please|bug|failed|error|timeout|investigate|broken|ci)\b/i

export interface SemanticHit {
  pass: boolean
  strength: Strength
  reason: string
}

export interface SemanticModel {
  readonly name: string
  classify(trigger: Trigger): SemanticHit
}

export interface FilterVerdict {
  action: 'drop' | 'pass'
  layer: 'fast' | 'semantic'
  strength?: Strength
  reason: string
  fast: string
  semantic: string
}

function addressed(trigger: Trigger): boolean {
  return trigger.addressed === 'mention'
    || trigger.addressed === 'direct'
    || /@ds-agent\b/i.test(trigger.text)
}

/** Program fast path: source allowlist, mention, keyword, obvious noise. */
export function fastPath(trigger: Trigger): { pass: boolean; reason: string } {
  if (
    trigger.source !== 'im'
    && trigger.source !== 'github'
    && trigger.source !== 'cli'
    && trigger.source !== 'a2a'
  ) {
    return { pass: false, reason: 'source-not-allowlisted' }
  }
  // No meta-based admission: `meta` is data, never a filter bypass.
  if (addressed(trigger)) return { pass: true, reason: 'mention-or-direct' }
  if (ACTION.test(trigger.text)) return { pass: true, reason: 'keyword' }
  if (NOISE.test(trigger.text) || trigger.text.trim().length < 12) {
    return { pass: false, reason: 'noise' }
  }
  return { pass: true, reason: 'observed' }
}

/**
 * Rule stand-in for the semantic model layer.
 * MockModel.classify delegates here so admission stays deterministic.
 */
export function ruleClassify(trigger: Trigger): SemanticHit {
  const mention = addressed(trigger)
  if (NOISE.test(trigger.text) && !ACTION.test(trigger.text)) {
    return { pass: false, strength: 'inferred', reason: 'noise' }
  }
  if (ACTION.test(trigger.text) && mention) {
    return { pass: true, strength: 'explicit', reason: 'explicit' }
  }
  if (ACTION.test(trigger.text)) {
    return { pass: true, strength: 'inferred', reason: 'inferred' }
  }
  if (mention) return { pass: true, strength: 'explicit', reason: 'explicit' }
  // A channel adapter's speculation hint is a strength, checked after noise so
  // it can never admit obvious chatter.
  if (trigger.speculate === true) return { pass: true, strength: 'maybe', reason: 'maybe' }
  return { pass: false, strength: 'inferred', reason: 'no-intent' }
}

/** Two-level filter. Fast path can drop before the semantic layer agrees. */
export function filterTrigger(trigger: Trigger, model: SemanticModel): FilterVerdict {
  const fast = fastPath(trigger)
  const semantic = model.classify(trigger)
  const fastLabel = `${fast.pass ? 'pass' : 'drop'}:${fast.reason}`
  const semanticLabel = `${semantic.pass ? 'pass' : 'drop'}:${semantic.reason}`
  if (!fast.pass) {
    return { action: 'drop', layer: 'fast', reason: fast.reason, fast: fastLabel, semantic: semanticLabel }
  }
  if (!semantic.pass) {
    return {
      action: 'drop',
      layer: 'semantic',
      reason: semantic.reason,
      fast: fastLabel,
      semantic: semanticLabel,
    }
  }
  return {
    action: 'pass',
    layer: 'semantic',
    strength: semantic.strength,
    reason: semantic.reason,
    fast: fastLabel,
    semantic: semanticLabel,
  }
}

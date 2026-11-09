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

/**
 * Deterministic admission rules (T16). They run before mention/keyword, so a
 * deny rule cannot be overridden by an @-mention. These are admission filters,
 * not authentication: an adapter that trusts a peer still has to verify it.
 */
export interface AdmissionRules {
  /** When non-empty, only these `trigger.actor.id` values may pass. */
  actors?: string[]
  /**
   * When non-empty, only these group ids may pass. The id comes from the
   * channel address (`trigger.channel.address.group`), never from `meta`.
   * A missing group is not allowed while this list is active.
   */
  groups?: string[]
  /** Always drop when `trigger.actor.id` matches, e.g. the daemon's own bot id. */
  dropSelf?: string[]
}

function admissionDeny(trigger: Trigger, rules?: AdmissionRules): string | undefined {
  if (!rules) return undefined
  if (rules.dropSelf?.length && rules.dropSelf.includes(trigger.actor.id)) return 'self-drop'
  if (rules.actors?.length && !rules.actors.includes(trigger.actor.id)) {
    return 'actor-not-allowlisted'
  }
  if (rules.groups?.length) {
    const group = trigger.channel?.address?.group?.trim()
    if (!group || !rules.groups.includes(group)) return 'group-not-allowlisted'
  }
  return undefined
}

function addressed(trigger: Trigger): boolean {
  return trigger.addressed === 'mention'
    || trigger.addressed === 'direct'
    || /@ds-agent\b/i.test(trigger.text)
}

/**
 * A 1:1 conversational thread (Feishu p2p, iMessage DM, CLI). Semantic
 * admission stays on deterministic rules so greetings and casual hellos are not
 * dropped by the optional model policy, which targets group and ambient traffic.
 */
export function directConversationalChat(trigger: Trigger): boolean {
  return trigger.source !== 'a2a'
    && trigger.addressed === 'direct'
    && trigger.channel?.address?.group == null
}

/** Program fast path: admission rules, source allowlist, mention, keyword, obvious noise. */
export function fastPath(
  trigger: Trigger,
  admission?: AdmissionRules,
): { pass: boolean; reason: string } {
  if (
    trigger.source !== 'im'
    && trigger.source !== 'github'
    && trigger.source !== 'cli'
    && trigger.source !== 'a2a'
    && trigger.source !== 'imessage'
  ) {
    return { pass: false, reason: 'source-not-allowlisted' }
  }
  // Deny rules precede mention/keyword so an allowlist-plus-mention still drops.
  // No meta-based admission: `meta` is data, never a filter bypass.
  const denied = admissionDeny(trigger, admission)
  if (denied) return { pass: false, reason: denied }
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
  // A 1:1 conversation is answered by the Router, so everyday chatter such as
  // "haha" is a valid message there and must not be dropped as noise. Group
  // messages keep the noise rule: they are input, not a conversation with us.
  // Agent-to-agent traffic is not a conversation either, even when addressed.
  const directChat = directConversationalChat(trigger)
  if (NOISE.test(trigger.text) && !ACTION.test(trigger.text) && !directChat) {
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
export function filterTrigger(
  trigger: Trigger,
  model: SemanticModel,
  admission?: AdmissionRules,
): FilterVerdict {
  const fast = fastPath(trigger, admission)
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

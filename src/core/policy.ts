import { isSpeculative } from '../speculate/gate.ts'
import type { Strength, Ticket, Trigger } from '../shared/types.ts'
import { commandOf } from './assessment.ts'

/**
 * Versioned admission rules. A Mandate records the version that admitted it,
 * so a later change to Policy is visible instead of silently rewriting history.
 */
export interface Policy {
  version: string
  /** Prototype `observe` mode: log inferred work instead of accepting it. */
  observeInferred: boolean
  autoAccept: {
    /** Human message addressed to the agent. */
    explicit: boolean
    /** Unaddressed human message inferred to be work. */
    inferred: boolean
    /** Bot / CI event. It may still fan out to an existing Ticket. */
    bot: boolean
    /** Explicitly tagged speculative work. */
    speculative: boolean
  }
}

export const DEFAULT_POLICY: Policy = {
  version: 'policy-v1',
  observeInferred: false,
  autoAccept: {
    explicit: true,
    inferred: false,
    bot: true,
    speculative: true,
  },
}

export type GateKind = 'accept' | 'ignore' | 'stop' | 'unavailable' | 'defer'

export interface GateDecision {
  kind: GateKind
  reason: string
  ticketId?: string
  strength?: Strength
  /** Policy rule ids that produced a deterministic decision. */
  rules?: string[]
}

export function strengthOf(trigger: Trigger): Strength {
  const value = trigger.meta.strength
  if (value === 'explicit' || value === 'inferred' || value === 'maybe') return value
  if (trigger.addressed) return 'explicit'
  return 'inferred'
}

/**
 * Deterministic Gate. It decides only what Policy can decide with certainty;
 * everything else is `defer`red to the Main Agent's Assessment.
 *
 * The Gate never waits: conditions such as "price below 100" belong to a
 * Source, not to Eval.
 */
export function gateTriggers(
  triggers: Trigger[],
  live: Ticket | undefined,
  policy: Policy = DEFAULT_POLICY,
): GateDecision {
  const primary = triggers.find(trigger => trigger.addressed) ?? triggers[0]
  if (!primary) return { kind: 'ignore', reason: 'empty-batch' }
  const strength = strengthOf(primary)
  const command = commandOf(primary.text)
  if (command === 'unavailable') {
    return { kind: 'unavailable', reason: 'assessor-unavailable', strength, rules: ['command:unavailable'] }
  }
  if (command === 'stop') {
    return live
      ? { kind: 'stop', reason: 'stop-requested', ticketId: live.id, strength, rules: ['command:stop'] }
      : { kind: 'ignore', reason: 'nothing-to-stop', strength, rules: ['command:stop'] }
  }
  if (command === 'ignore') {
    return { kind: 'ignore', reason: 'no-action', strength, rules: ['command:ignore'] }
  }

  if (isSpeculative(strength)) {
    return policy.autoAccept.speculative
      ? { kind: 'accept', reason: 'speculative', strength: 'maybe', rules: ['policy:speculative'] }
      : { kind: 'defer', reason: 'speculative-needs-main', strength, rules: ['policy:speculative'] }
  }

  if (primary.addressed) {
    return policy.autoAccept.explicit
      ? { kind: 'accept', reason: 'explicit', strength: 'explicit', rules: ['policy:explicit'] }
      : { kind: 'defer', reason: 'explicit-needs-main', strength: 'explicit', rules: ['policy:explicit'] }
  }

  if (!primary.human) {
    return policy.autoAccept.bot
      ? { kind: 'accept', reason: 'bot', strength, rules: ['policy:bot'] }
      : { kind: 'defer', reason: 'bot-needs-main', strength, rules: ['policy:bot'] }
  }

  if (policy.observeInferred) {
    return { kind: 'ignore', reason: 'observe: would accept inferred work', strength, rules: ['policy:observe'] }
  }
  if (policy.autoAccept.inferred) {
    return { kind: 'accept', reason: 'inferred', strength, rules: ['policy:inferred'] }
  }
  return { kind: 'defer', reason: 'inferred-needs-main', strength, rules: ['policy:inferred'] }
}

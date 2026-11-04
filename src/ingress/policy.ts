import {
  fastPath,
  ruleClassify,
  type AdmissionRules,
  type FilterVerdict,
  type SemanticHit,
  type SemanticModel,
} from './filter.ts'
import type { Strength, Trigger } from '../shared/types.ts'

/**
 * MODEL-SLOW-PATH (T17): the Slow Path's optional model-backed policy.
 *
 * The default ingress path stays deterministic (`ruleClassify`). This module
 * adds an opt-in async policy, a structured-output HTTP implementation in the
 * Harness, and a classifier that turns every failure into the rule verdict.
 * A policy never sees unredacted text and never receives tools.
 */

/** Default hard bound for one policy call, including the HTTP round trip. */
export const DEFAULT_POLICY_TIMEOUT_MS = 3000
/** Reasons are operator-facing log fields, not model prose. */
export const MAX_POLICY_REASON_LENGTH = 80
export const POLICY_STRENGTHS: readonly Strength[] = ['explicit', 'inferred', 'maybe']

/** Async policy contract. Implementations must not mutate the Trigger. */
export interface SemanticPolicy {
  readonly name: string
  classifyPolicy(trigger: Trigger): Promise<SemanticHit>
}

/** A structurally valid policy implementation, used before wrapping it. */
export function isSemanticPolicy(value: unknown): value is SemanticPolicy {
  return value != null && typeof (value as SemanticPolicy).classifyPolicy === 'function'
}

/**
 * Raised when a policy produced bytes we cannot safely interpret. The
 * classifier maps this to `fallback:invalid`; the message never contains the
 * model output or the API key.
 */
export class PolicyOutputError extends Error {
  constructor() {
    super('policy output is not a valid semantic hit')
    this.name = 'PolicyOutputError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/** Trim a reason to one short log-safe line. */
export function clampPolicyReason(reason: string): string {
  const line = reason.replace(/\s+/g, ' ').trim()
  return line.slice(0, MAX_POLICY_REASON_LENGTH)
}

/**
 * Strict shape check for a policy hit. `pass` must be a boolean, `strength`
 * one of the three documented labels, and `reason` a string.
 */
export function isValidSemanticHit(value: unknown): value is SemanticHit {
  if (!isRecord(value)) return false
  return typeof value.pass === 'boolean'
    && typeof value.reason === 'string'
    && POLICY_STRENGTHS.includes(value.strength as Strength)
}

/**
 * Wrap an async policy with a hard timeout and a deterministic fallback.
 *
 * Every resolution is a `SemanticHit`: a timeout, a throw, or an invalid hit
 * becomes `ruleClassify(trigger)` with `fallback:<cause>`. `classify` never
 * rejects, so ingress cannot hang on a slow or broken model.
 */
export class PolicyClassifier {
  constructor(
    readonly policy: SemanticPolicy,
    private readonly timeoutMs = DEFAULT_POLICY_TIMEOUT_MS,
  ) {}

  get name(): string {
    return this.policy.name
  }

  async classify(trigger: Trigger): Promise<SemanticHit> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PolicyTimeoutError()), this.timeoutMs)
        // A pending policy call must not keep the process alive on shutdown.
        ;(timer as { unref?: () => void }).unref?.()
      })
      const hit = await Promise.race([this.policy.classifyPolicy(trigger), expired])
      if (!isValidSemanticHit(hit)) return fallback(trigger, 'invalid')
      return hit
    } catch (error) {
      return fallback(trigger, fallbackCause(error))
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

class PolicyTimeoutError extends Error {
  constructor() {
    super('policy timed out')
    this.name = 'PolicyTimeoutError'
  }
}

function fallbackCause(error: unknown): 'timeout' | 'invalid' | 'error' {
  if (error instanceof PolicyOutputError) return 'invalid'
  if (error instanceof PolicyTimeoutError) return 'timeout'
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'timeout'
  }
  return 'error'
}

/** Keep the rule's strength; only the reason names the degraded path. */
function fallback(trigger: Trigger, cause: 'timeout' | 'invalid' | 'error'): SemanticHit {
  return { ...ruleClassify(trigger), reason: `fallback:${cause}` }
}

/**
 * Fast-path-first async filter. The model policy is consulted only after the
 * deterministic fast path passes; a fast drop can never be overridden by it.
 */
export async function filterTriggerWithPolicy(
  trigger: Trigger,
  model: SemanticModel,
  admission?: AdmissionRules,
  policy?: PolicyClassifier,
): Promise<FilterVerdict> {
  const fast = fastPath(trigger, admission)
  const fastLabel = `${fast.pass ? 'pass' : 'drop'}:${fast.reason}`
  if (!fast.pass) {
    return {
      action: 'drop',
      layer: 'fast',
      reason: fast.reason,
      fast: fastLabel,
      semantic: 'skip:fast-drop',
    }
  }
  // `model` is the synchronous rules classifier used when no policy is wired.
  const semantic = policy ? await policy.classify(trigger) : model.classify(trigger)
  const semanticLabel = `${semantic.pass ? 'pass' : 'drop'}:${semantic.reason}`
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

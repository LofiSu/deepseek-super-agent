import type { Strength, Trigger } from '../shared/types.ts'

/**
 * Lexicon shared with the fast path so both layers name the same tokens.
 * The slow path stays deterministic: admission must not wait on a second model call.
 */
export const NOISE = /\b(lol|lmao|haha|weather|lunch)\b/i
export const ACTION = /\b(fix|please|bug|failed|error|timeout|investigate|broken|ci)\b/i

export const SLOW_PATH_POLICY = [
  'Deterministic slow path. Do not call the chat model from admission.',
  'Collect signals in order: mention, action, noise, speculate.',
  'mention + action → explicit admit.',
  'mention → explicit admit. A direct address outranks noise.',
  'action → inferred admit. An action token outranks noise.',
  'noise without mention or action → drop as noise.',
  'speculate tag → maybe admit.',
  'otherwise → drop as no-intent.',
  'The fast path can still veto this result.',
].join(' ')

export interface SlowHit {
  pass: boolean
  strength: Strength
  reason: string
  signals: string[]
  policy: 'rules'
}

const cache = new Map<string, SlowHit>()
const stats = { hits: 0, misses: 0 }
const CACHE_MAX = 200

export function slowPathStats(): { hits: number; misses: number; size: number } {
  return { hits: stats.hits, misses: stats.misses, size: cache.size }
}

export function clearSlowPathCache(): void {
  cache.clear()
  stats.hits = 0
  stats.misses = 0
}

export function isAddressed(trigger: Trigger): boolean {
  return trigger.addressed === 'mention'
    || trigger.addressed === 'direct'
    || /@ds-agent\b/i.test(trigger.text)
}

function cacheKey(trigger: Trigger): string {
  return [trigger.text, trigger.addressed ?? '', trigger.meta.speculate === true ? '1' : '0'].join('\u0000')
}

function decide(trigger: Trigger): SlowHit {
  const signals: string[] = []
  const mention = isAddressed(trigger)
  const action = ACTION.test(trigger.text)
  const noise = NOISE.test(trigger.text)
  const speculate = trigger.meta.speculate === true
  if (mention) signals.push('mention')
  if (action) signals.push('action')
  if (noise) signals.push('noise')
  if (speculate) signals.push('speculate')
  if (mention && action) return hit(true, 'explicit', 'explicit', signals)
  if (mention) return hit(true, 'explicit', 'explicit', signals)
  if (action) return hit(true, 'inferred', 'inferred', signals)
  if (noise) return hit(false, 'inferred', 'noise', signals)
  if (speculate) return hit(true, 'maybe', 'maybe', signals)
  signals.push('no-intent')
  return hit(false, 'inferred', 'no-intent', signals)
}

function hit(pass: boolean, strength: Strength, reason: string, signals: string[]): SlowHit {
  return { pass, strength, reason, signals: [...signals], policy: 'rules' }
}

/** Cached deterministic policy. Same text, address, and speculate tag reuse one decision. */
export function slowPath(trigger: Trigger): SlowHit {
  const key = cacheKey(trigger)
  const cached = cache.get(key)
  if (cached) {
    stats.hits += 1
    return { ...cached, signals: [...cached.signals] }
  }
  stats.misses += 1
  const decided = decide(trigger)
  cache.set(key, decided)
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return { ...decided, signals: [...decided.signals] }
}

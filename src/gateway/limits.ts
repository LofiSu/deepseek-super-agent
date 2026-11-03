/**
 * Per-provider concurrency lanes, RPM windows and a soft daily token budget,
 * mirroring Magpie's gateway "Limits" behaviour. A saturated provider is
 * skipped for that request (another candidate is tried); when every candidate
 * is saturated the request is answered 429 with `Retry-After`.
 */

export interface LimitConfig {
  maxConcurrency?: number
  maxRpm?: number
  dailyTokens?: number
}

export interface LimitSnapshot {
  inFlight: number
  rpmUsed: number
  tokensToday: number
  exhausted: boolean
}

/** How long a transient 429/402 rests a provider before it is retried. */
export const DEFAULT_REST_MS = 60_000

export class GatewayLimits {
  private readonly inFlight = new Map<string, number>()
  private readonly rpm = new Map<string, number[]>()
  private readonly tokens = new Map<string, number>()
  private readonly restedUntil = new Map<string, number>()
  private tokenDay = ''

  constructor(
    private readonly configFor: (providerId: string) => LimitConfig = () => ({}),
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Can this provider take a request right now? (No side effect.) */
  available(providerId: string): boolean {
    this.rollDay()
    if (this.restedFor(providerId) > 0) return false
    const config = this.configFor(providerId)
    if (config.maxConcurrency != null && (this.inFlight.get(providerId) ?? 0) >= config.maxConcurrency) return false
    if (config.maxRpm != null && this.rpmCount(providerId) >= config.maxRpm) return false
    if (config.dailyTokens != null && (this.tokens.get(providerId) ?? 0) >= config.dailyTokens) return false
    return true
  }

  /** Reserve a slot (concurrency + RPM). False when unavailable, with nothing recorded. */
  acquire(providerId: string): boolean {
    if (!this.available(providerId)) return false
    this.inFlight.set(providerId, (this.inFlight.get(providerId) ?? 0) + 1)
    const list = this.rpm.get(providerId) ?? []
    list.push(this.now())
    this.rpm.set(providerId, list)
    return true
  }

  release(providerId: string): void {
    const current = this.inFlight.get(providerId) ?? 0
    if (current <= 1) this.inFlight.delete(providerId)
    else this.inFlight.set(providerId, current - 1)
  }

  recordTokens(providerId: string, tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return
    this.rollDay()
    const total = (this.tokens.get(providerId) ?? 0) + tokens
    this.tokens.set(providerId, total)
    const config = this.configFor(providerId)
    if (config.dailyTokens != null && total >= config.dailyTokens) {
      // Spend the rest of the UTC day rested, not the rest of the process's life.
      this.rest(providerId, Math.max(1_000, this.nextUtcMidnight() - this.now()))
    }
  }

  /**
   * Rest a provider after a 429 / 402 / quota refusal. The rest expires after
   * `durationMs` (default 60s), so one transient upstream refusal cannot
   * disable a provider for the lifetime of the process.
   */
  rest(providerId: string, durationMs: number = DEFAULT_REST_MS): void {
    this.restedUntil.set(providerId, this.now() + Math.max(0, durationMs))
  }

  unrest(providerId: string): void {
    this.restedUntil.delete(providerId)
  }

  retryAfterMs(providerId: string): number {
    const rested = this.restedFor(providerId)
    if (rested > 0) return rested
    const list = this.rpmList(providerId)
    if (list.length === 0) return 1_000
    const oldest = list[0]!
    return Math.max(0, 60_000 - (this.now() - oldest))
  }

  snapshot(providerId: string): LimitSnapshot {
    this.rollDay()
    return {
      inFlight: this.inFlight.get(providerId) ?? 0,
      rpmUsed: this.rpmCount(providerId),
      tokensToday: this.tokens.get(providerId) ?? 0,
      exhausted: this.restedFor(providerId) > 0,
    }
  }

  /** Remaining rest time in ms; 0 when the provider is available. */
  private restedFor(providerId: string): number {
    const until = this.restedUntil.get(providerId)
    if (until === undefined) return 0
    const remaining = until - this.now()
    if (remaining <= 0) {
      this.restedUntil.delete(providerId)
      return 0
    }
    return remaining
  }

  /** Reset the per-day token counters when the UTC date changes. */
  private rollDay(): void {
    const day = new Date(this.now()).toISOString().slice(0, 10)
    if (day === this.tokenDay) return
    this.tokenDay = day
    this.tokens.clear()
  }

  private nextUtcMidnight(): number {
    const date = new Date(this.now())
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
  }

  private rpmList(providerId: string): number[] {
    const cutoff = this.now() - 60_000
    const list = (this.rpm.get(providerId) ?? []).filter(at => at > cutoff)
    if (list.length > 0) this.rpm.set(providerId, list)
    else this.rpm.delete(providerId)
    return list
  }

  private rpmCount(providerId: string): number {
    return this.rpmList(providerId).length
  }
}

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

export class GatewayLimits {
  private readonly inFlight = new Map<string, number>()
  private readonly rpm = new Map<string, number[]>()
  private readonly tokens = new Map<string, number>()
  private readonly rested = new Set<string>()

  constructor(
    private readonly configFor: (providerId: string) => LimitConfig = () => ({}),
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Can this provider take a request right now? (No side effect.) */
  available(providerId: string): boolean {
    if (this.rested.has(providerId)) return false
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
    const total = (this.tokens.get(providerId) ?? 0) + tokens
    this.tokens.set(providerId, total)
    const config = this.configFor(providerId)
    if (config.dailyTokens != null && total >= config.dailyTokens) this.rested.add(providerId)
  }

  /** Rest a provider (429 / 402 / quota refusal) until `unrest`. */
  rest(providerId: string): void {
    this.rested.add(providerId)
  }

  unrest(providerId: string): void {
    this.rested.delete(providerId)
  }

  retryAfterMs(providerId: string): number {
    const list = this.rpmList(providerId)
    if (list.length === 0) return 1_000
    const oldest = list[0]!
    return Math.max(0, 60_000 - (this.now() - oldest))
  }

  snapshot(providerId: string): LimitSnapshot {
    return {
      inFlight: this.inFlight.get(providerId) ?? 0,
      rpmUsed: this.rpmCount(providerId),
      tokensToday: this.tokens.get(providerId) ?? 0,
      exhausted: this.rested.has(providerId),
    }
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

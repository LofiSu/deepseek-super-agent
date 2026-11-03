/**
 * In-process usage ledger: one row per request attempt (provider, model,
 * status, latency, tokens, ok). Mirrors Magpie's usage records, and feeds the
 * gateway's `onUsage` plugin hook. Bounded so it can't grow without limit.
 */

export interface UsageRow {
  at: string
  protocol: string
  provider: string
  model: string
  requested?: string
  status: number
  latencyMs: number
  tokens: number
  ok: boolean
  routing?: string
}

export interface UsageBucket {
  provider: string
  model: string
  requests: number
  errors: number
  tokens: number
  latencyMs: number
}

export interface UsageSummary {
  requests: number
  errors: number
  tokens: number
  byProviderModel: UsageBucket[]
}

export class UsageLedger {
  private readonly rows: UsageRow[] = []

  constructor(private readonly limit = 5_000) {}

  record(row: UsageRow): UsageRow {
    this.rows.push(row)
    if (this.rows.length > this.limit) this.rows.splice(0, this.rows.length - this.limit)
    return row
  }

  recent(count = 100): UsageRow[] {
    return this.rows.slice(-Math.max(1, Math.floor(count)))
  }

  size(): number {
    return this.rows.length
  }

  summary(): UsageSummary {
    let requests = 0
    let errors = 0
    let tokens = 0
    const buckets = new Map<string, UsageBucket>()
    for (const row of this.rows) {
      requests += 1
      if (!row.ok) errors += 1
      tokens += row.tokens
      const key = `${row.provider}\u0000${row.model}`
      let bucket = buckets.get(key)
      if (!bucket) {
        bucket = { provider: row.provider, model: row.model, requests: 0, errors: 0, tokens: 0, latencyMs: 0 }
        buckets.set(key, bucket)
      }
      bucket.requests += 1
      if (!row.ok) bucket.errors += 1
      bucket.tokens += row.tokens
      bucket.latencyMs += row.latencyMs
    }
    return { requests, errors, tokens, byProviderModel: [...buckets.values()] }
  }
}

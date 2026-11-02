import type { MetricsSnapshot } from './metrics.ts'

/**
 * T45 / PLAN §7: end-to-end latency curve.
 *
 * Counters alone cannot answer "how slow is the slow tail?". This module keeps the
 * raw model-latency samples (optionally persisted as `curveSamples` in metrics.json)
 * and derives nearest-rank percentiles from them. It is pure: callers own storage.
 */

/** Oldest samples are dropped once the list grows past this length. */
export const DEFAULT_CURVE_SAMPLE_LIMIT = 1024

export interface CurveSummary {
  count: number
  p50: number
  p95: number
  max: number
}

/** A snapshot (uses its `curveSamples`) or a bare samples list. */
export type CurveSampleSource = MetricsSnapshot | readonly number[] | null | undefined

function asSample(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.round(value))
}

function asLimit(limit: number | undefined): number {
  return Number.isFinite(limit) && (limit as number) > 0
    ? Math.floor(limit as number)
    : DEFAULT_CURVE_SAMPLE_LIMIT
}

/**
 * Drops non-finite values, clamps negatives to zero, and keeps the newest `limit`
 * samples. Safe to call on data loaded from an older or hand-edited metrics.json.
 */
export function normalizeCurveSamples(
  samples: readonly unknown[] | undefined,
  limit: number = DEFAULT_CURVE_SAMPLE_LIMIT,
): number[] {
  const cap = asLimit(limit)
  const clean: number[] = []
  if (Array.isArray(samples)) {
    for (const value of samples) {
      const sample = asSample(value)
      if (sample !== undefined) clean.push(sample)
    }
  }
  return clean.length > cap ? clean.slice(clean.length - cap) : clean
}

/** Returns the samples a source exposes; snapshots without `curveSamples` yield `[]`. */
export function curveSamples(source: CurveSampleSource): number[] {
  if (Array.isArray(source)) return normalizeCurveSamples(source)
  if (source && typeof source === 'object') {
    return normalizeCurveSamples((source as MetricsSnapshot).curveSamples)
  }
  return []
}

/**
 * Appends one model-latency observation to a snapshot, returning a new snapshot.
 * The input snapshot is not mutated. Invalid samples are ignored.
 */
export function recordLatencySample(
  snapshot: MetricsSnapshot,
  ms: number,
  limit: number = DEFAULT_CURVE_SAMPLE_LIMIT,
): MetricsSnapshot {
  const cap = asLimit(limit)
  const current = normalizeCurveSamples(snapshot.curveSamples, cap)
  const sample = asSample(ms)
  const next = sample === undefined ? current : [...current, sample]
  return {
    ...snapshot,
    curveSamples: next.length > cap ? next.slice(next.length - cap) : next,
  }
}

function percentile(sorted: readonly number[], p: number): number {
  // Nearest-rank: rank = ceil(p/100 * n), clamped into the array.
  const rank = Math.ceil((p / 100) * sorted.length)
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[index]!
}

/** p50/p95/max/count over the samples; all zeros when there are no samples. */
export function summarizeCurve(source: CurveSampleSource): CurveSummary {
  const samples = curveSamples(source).sort((a, b) => a - b)
  if (samples.length === 0) return { count: 0, p50: 0, p95: 0, max: 0 }
  return {
    count: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    max: samples[samples.length - 1]!,
  }
}

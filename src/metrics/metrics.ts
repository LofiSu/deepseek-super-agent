import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_CURVE_SAMPLE_LIMIT, normalizeCurveSamples, recordLatencySample } from './curve.ts'

/**
 * Blog §7 counters. Written to `<stateDir>/metrics.json` and printed by `ds-agent metrics`.
 * Model latency is milliseconds across Router, Worker, and Watchdog completions.
 */
export const METRIC_NAMES = [
  'ingress.admit',
  'ingress.drop',
  'eval.accept',
  'bypass.fanout',
  'speculate.deliver',
  'speculate.discard',
  'watchdog.nudge',
  'watchdog.fail',
  'watchdog.idle',
] as const

export type MetricName = (typeof METRIC_NAMES)[number]

export interface ModelLatencyMs {
  count: number
  sum: number
  max: number
  last: number
}

export interface MetricsSnapshot {
  counters: Record<MetricName, number>
  modelLatencyMs: ModelLatencyMs
  /** Optional raw latency samples (Phase-2 T45 curve); absent until recorded. */
  curveSamples?: number[]
}

function blankCounters(): Record<MetricName, number> {
  return {
    'ingress.admit': 0,
    'ingress.drop': 0,
    'eval.accept': 0,
    'bypass.fanout': 0,
    'speculate.deliver': 0,
    'speculate.discard': 0,
    'watchdog.nudge': 0,
    'watchdog.fail': 0,
    'watchdog.idle': 0,
  }
}

function blankLatency(): ModelLatencyMs {
  return { count: 0, sum: 0, max: 0, last: 0 }
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function metricsPath(stateDir: string): string {
  return path.join(stateDir, 'metrics.json')
}

export function emptySnapshot(): MetricsSnapshot {
  return { counters: blankCounters(), modelLatencyMs: blankLatency() }
}

export function normalizeSnapshot(value: unknown): MetricsSnapshot {
  const raw = value && typeof value === 'object'
    ? value as {
      counters?: Partial<Record<MetricName, unknown>>
      modelLatencyMs?: Partial<ModelLatencyMs>
      curveSamples?: unknown
    }
    : {}
  const counters = blankCounters()
  for (const name of METRIC_NAMES) counters[name] = asNumber(raw.counters?.[name])
  const latency = raw.modelLatencyMs ?? {}
  const snapshot: MetricsSnapshot = {
    counters,
    modelLatencyMs: {
      count: asNumber(latency.count),
      sum: asNumber(latency.sum),
      max: asNumber(latency.max),
      last: asNumber(latency.last),
    },
  }
  if (Array.isArray(raw.curveSamples)) {
    snapshot.curveSamples = normalizeCurveSamples(raw.curveSamples)
  }
  return snapshot
}

export function readMetrics(stateDir: string): MetricsSnapshot {
  try {
    return normalizeSnapshot(JSON.parse(fs.readFileSync(metricsPath(stateDir), 'utf8')))
  } catch {
    return emptySnapshot()
  }
}

export function formatMetricsJson(stateDir: string): string {
  return JSON.stringify(readMetrics(stateDir), null, 2)
}

export class Metrics {
  readonly file: string
  private readonly counters: Record<MetricName, number>
  private latency: ModelLatencyMs
  private curve: number[] | undefined

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true })
    this.file = metricsPath(stateDir)
    const loaded = readMetrics(stateDir)
    this.counters = loaded.counters
    this.latency = loaded.modelLatencyMs
    this.curve = loaded.curveSamples
  }

  increment(name: MetricName, by = 1): void {
    if (!Number.isFinite(by) || by <= 0) return
    this.counters[name] += by
    this.flush()
  }

  observeModelLatency(ms: number): void {
    const sample = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0
    this.latency.count += 1
    this.latency.sum += sample
    this.latency.last = sample
    if (sample > this.latency.max) this.latency.max = sample
    this.curve = recordLatencySample(
      { counters: this.counters, modelLatencyMs: this.latency, curveSamples: this.curve },
      sample,
      DEFAULT_CURVE_SAMPLE_LIMIT,
    ).curveSamples
    this.flush()
  }

  snapshot(): MetricsSnapshot {
    const snapshot: MetricsSnapshot = {
      counters: { ...this.counters },
      modelLatencyMs: { ...this.latency },
    }
    if (this.curve) snapshot.curveSamples = [...this.curve]
    return snapshot
  }

  flush(): void {
    fs.writeFileSync(this.file, `${JSON.stringify(this.snapshot(), null, 2)}\n`)
  }
}

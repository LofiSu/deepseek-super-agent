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
  'bypass.context',
  'executor.fail',
  'speculate.deliver',
  'speculate.discard',
  'watchdog.nudge',
  'watchdog.fail',
  'watchdog.idle',
  'model.error',
  'model.call',
  'router.shard',
  'mesh.assigned',
  'memory.remembered',
  'memory.recalled',
  'a2a.delivery',
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
  /** Optional raw latency samples (T45 curve); absent until recorded. */
  curveSamples?: number[]
}

function blankCounters(): Record<MetricName, number> {
  return {
    'ingress.admit': 0,
    'ingress.drop': 0,
    'eval.accept': 0,
    'bypass.fanout': 0,
    'bypass.context': 0,
    'executor.fail': 0,
    'speculate.deliver': 0,
    'speculate.discard': 0,
    'watchdog.nudge': 0,
    'watchdog.fail': 0,
    'watchdog.idle': 0,
    'model.error': 0,
    'model.call': 0,
    'router.shard': 0,
    'mesh.assigned': 0,
    'memory.remembered': 0,
    'memory.recalled': 0,
    'a2a.delivery': 0,
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

function cloneSnapshot(snapshot: MetricsSnapshot): MetricsSnapshot {
  const clone: MetricsSnapshot = {
    counters: { ...snapshot.counters },
    modelLatencyMs: { ...snapshot.modelLatencyMs },
  }
  if (snapshot.curveSamples) clone.curveSamples = [...snapshot.curveSamples]
  return clone
}

export class Metrics {
  readonly file: string
  private readonly counters: Record<MetricName, number>
  private latency: ModelLatencyMs
  private curve: number[] | undefined
  /** Last snapshot this process wrote or read. Used to merge other processes' increments. */
  private baseline: MetricsSnapshot
  private timer: NodeJS.Immediate | null = null

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true })
    this.file = metricsPath(stateDir)
    const loaded = readMetrics(stateDir)
    this.counters = loaded.counters
    this.latency = loaded.modelLatencyMs
    this.curve = loaded.curveSamples
    this.baseline = cloneSnapshot(loaded)
  }

  increment(name: MetricName, by = 1): void {
    if (!Number.isFinite(by) || by <= 0) return
    this.counters[name] += by
    this.scheduleFlush()
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
    // Latency observations are rare (one per model turn) and upstream callers
    // read metrics.json right after recording, so persist them synchronously.
    // Counter increments remain coalesced.
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

  /**
   * Coalesce hot-path increments into one write per event-loop turn.
   * `flush()` remains synchronous and atomic for callers that need the file now.
   */
  private scheduleFlush(): void {
    if (this.timer) return
    this.timer = setImmediate(() => {
      this.timer = null
      try {
        this.flush()
      } catch {
        // A transient write failure must not crash the daemon. The next metric
        // increment schedules another attempt; explicit flush() still throws.
      }
    })
  }

  flush(): void {
    if (this.timer) {
      clearImmediate(this.timer)
      this.timer = null
    }
    this.mergeDisk()
    const next = this.snapshot()
    const temp = `${this.file}.${process.pid}.tmp`
    try {
      fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`)
      // rename is atomic on the same filesystem: readers see the old or new file,
      // never a half-written one.
      fs.renameSync(temp, this.file)
      this.baseline = cloneSnapshot(next)
    } catch (error) {
      try {
        fs.rmSync(temp, { force: true })
      } catch {
        // Best effort cleanup; the original error matters more.
      }
      throw error
    }
  }

  /**
   * Fold in counters written by another process since our last flush.
   * Counters and latency counts are monotonic, so deltas merge cleanly.
   */
  private mergeDisk(): void {
    const disk = readMetrics(path.dirname(this.file))
    for (const name of METRIC_NAMES) {
      const delta = disk.counters[name] - this.baseline.counters[name]
      if (delta > 0) this.counters[name] += delta
    }
    const countDelta = disk.modelLatencyMs.count - this.baseline.modelLatencyMs.count
    if (countDelta > 0) {
      this.latency.count += countDelta
      this.latency.sum += Math.max(0, disk.modelLatencyMs.sum - this.baseline.modelLatencyMs.sum)
      if (disk.modelLatencyMs.max > this.latency.max) this.latency.max = disk.modelLatencyMs.max
    }
  }
}

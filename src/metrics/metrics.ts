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
  'mesh.queued',
  'mesh.dequeued',
  'mesh.queue_rejected',
  'mesh.queue_drained',
  'memory.remembered',
  'memory.recalled',
  'a2a.delivery',
  'mcp.connect',
  'mcp.connect_error',
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
    'mesh.queued': 0,
    'mesh.dequeued': 0,
    'mesh.queue_rejected': 0,
    'mesh.queue_drained': 0,
    'memory.remembered': 0,
    'memory.recalled': 0,
    'a2a.delivery': 0,
    'mcp.connect': 0,
    'mcp.connect_error': 0,
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

const LOCK_RETRY_MS = 5
// Short enough that a contended flush cannot freeze the daemon for long.
const LOCK_TIMEOUT_MS = 1_500
const STALE_LOCK_MS = 3_000

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but we may not signal it.
    return isErrno(error, 'EPERM')
  }
}

/** Remove a lock only when it is old and its recorded owner is gone. */
function clearStaleLock(lock: string): boolean {
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs <= STALE_LOCK_MS) return false
    const pid = Number.parseInt(fs.readFileSync(lock, 'utf8').trim(), 10)
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isProcessAlive(pid)) return false
    fs.rmSync(lock, { force: true })
    return true
  } catch {
    return false
  }
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
  /** Samples recorded since the last successful flush, for cross-process merging. */
  private readonly pendingSamples: number[] = []
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
    this.pendingSamples.push(sample)
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
    // The lock makes the whole read-modify-replace sequence atomic across
    // processes, not just each individual file operation.
    this.withFileLock(() => {
      this.mergeDisk()
      const next = this.snapshot()
      const temp = `${this.file}.${process.pid}.tmp`
      try {
        fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`)
        // rename is atomic on the same filesystem: readers see the old or new file,
        // never a half-written one.
        fs.renameSync(temp, this.file)
        this.baseline = cloneSnapshot(next)
        this.pendingSamples.length = 0
      } catch (error) {
        try {
          fs.rmSync(temp, { force: true })
        } catch {
          // Best effort cleanup; the original error matters more.
        }
        throw error
      }
    })
  }

  /** Cross-process mutex around one merge-and-replace. Synchronous by design. */
  private withFileLock<T>(fn: () => T): T {
    const lock = `${this.file}.lock`
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    for (;;) {
      try {
        const fd = fs.openSync(lock, 'wx')
        fs.writeSync(fd, String(process.pid))
        fs.closeSync(fd)
        break
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error
        // A crashed writer leaves the lock behind; an old lock with a dead
        // owner is stale. A live holder is never stolen.
        if (clearStaleLock(lock)) continue
        if (Date.now() >= deadline) throw new Error(`metrics lock timeout: ${lock}`)
        sleepSync(LOCK_RETRY_MS)
      }
    }
    try {
      return fn()
    } finally {
      try {
        fs.rmSync(lock, { force: true })
      } catch {
        // The next writer treats an old lock file as stale.
      }
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
      // No local observation since the last flush: the disk's sample is newer.
      if (this.pendingSamples.length === 0) this.latency.last = disk.modelLatencyMs.last
      // Another process persisted samples we have not written. Keep them and
      // append our own pending ones instead of overwriting with a stale curve.
      if (disk.curveSamples) {
        let merged = [...disk.curveSamples]
        for (const sample of this.pendingSamples) {
          merged = recordLatencySample(
            { counters: this.counters, modelLatencyMs: this.latency, curveSamples: merged },
            sample,
            DEFAULT_CURVE_SAMPLE_LIMIT,
          ).curveSamples!
        }
        this.curve = merged
      }
    }
  }
}

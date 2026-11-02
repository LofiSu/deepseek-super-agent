import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  recordLatencySample,
  summarizeCurve,
} from '../src/metrics/curve.ts'
import { compareBakeoff, type BakeoffSample } from '../src/metrics/bakeoff.ts'
import {
  Metrics,
  emptySnapshot,
  metricsPath,
  readMetrics,
  type MetricsSnapshot,
} from '../src/metrics/metrics.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-curve-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('T45 metrics curve', () => {
  it('summarizes an empty curve as zeros', () => {
    const zero = { count: 0, p50: 0, p95: 0, max: 0 }
    expect(summarizeCurve(undefined)).toEqual(zero)
    expect(summarizeCurve([])).toEqual(zero)
    expect(summarizeCurve(emptySnapshot())).toEqual(zero)
    expect(summarizeCurve({ ...emptySnapshot(), curveSamples: [] })).toEqual(zero)
  })

  it('uses nearest-rank p50/p95 over sorted samples', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(summarizeCurve(samples)).toEqual({ count: 100, p50: 50, p95: 95, max: 100 })
  })

  it('rounds values, clamps negatives, and drops non-finite samples', () => {
    expect(summarizeCurve([30, 10.4, 10.6, Number.NaN, -5, Number.POSITIVE_INFINITY]))
      .toEqual({ count: 4, p50: 10, p95: 30, max: 30 })
  })

  it('records samples without mutating the source snapshot and keeps the newest ones', () => {
    const base: MetricsSnapshot = { ...emptySnapshot(), curveSamples: [5, 10] }
    const next = recordLatencySample(base, 7.6, 2)
    expect(base.curveSamples).toEqual([5, 10])
    expect(next.curveSamples).toEqual([10, 8])
    expect(next.counters).toEqual(base.counters)
    expect(next.modelLatencyMs).toEqual(base.modelLatencyMs)
  })

  it('creates the samples list on first record and ignores invalid samples', () => {
    const base = emptySnapshot()
    expect(base.curveSamples).toBeUndefined()
    expect(recordLatencySample(base, 12).curveSamples).toEqual([12])
    expect(recordLatencySample({ ...base, curveSamples: [12] }, Number.NaN).curveSamples)
      .toEqual([12])
  })

  it('persists curveSamples in metrics.json while keeping latency counters intact', () => {
    const dir = tempDir()
    const metrics = new Metrics(dir)
    expect(metrics.snapshot().curveSamples).toBeUndefined()

    metrics.observeModelLatency(12)
    metrics.observeModelLatency(30.4)
    metrics.observeModelLatency(7)

    const snapshot = metrics.snapshot()
    expect(snapshot.curveSamples).toEqual([12, 30, 7])
    expect(snapshot.modelLatencyMs).toEqual({ count: 3, sum: 49, max: 30, last: 7 })

    const onDisk = JSON.parse(fs.readFileSync(metricsPath(dir), 'utf8')) as MetricsSnapshot
    expect(onDisk.curveSamples).toEqual([12, 30, 7])
    expect(readMetrics(dir)).toEqual(snapshot)
    expect(summarizeCurve(readMetrics(dir))).toEqual({ count: 3, p50: 12, p95: 30, max: 30 })
  })

  it('loads legacy metrics.json without curveSamples and appends from a fresh instance', () => {
    const dir = tempDir()
    fs.writeFileSync(metricsPath(dir), JSON.stringify({
      counters: { 'ingress.admit': 4 },
      modelLatencyMs: { count: 2, sum: 30, max: 20, last: 10 },
    }))

    const metrics = new Metrics(dir)
    const before = metrics.snapshot()
    expect(before.curveSamples).toBeUndefined()
    expect(before.counters['ingress.admit']).toBe(4)
    expect(before.modelLatencyMs).toEqual({ count: 2, sum: 30, max: 20, last: 10 })

    metrics.observeModelLatency(25)
    const after = readMetrics(dir)
    expect(after.curveSamples).toEqual([25])
    expect(after.counters['ingress.admit']).toBe(4)
    expect(after.modelLatencyMs).toEqual({ count: 3, sum: 55, max: 25, last: 25 })
  })
})

describe('T45 dual-layer vs single-session bake-off', () => {
  const sample = (mode: 'dual' | 'single', calls: number, wall: number): BakeoffSample => ({
    mode,
    modelCalls: calls,
    tickets: 1,
    evalAccepts: 1,
    wallMs: wall,
    counters: { 'model.call': calls, 'eval.accept': 1 },
  })

  it('reports the extra Router calls and per-ticket cost', () => {
    const comparison = compareBakeoff(sample('dual', 4, 200), sample('single', 2, 100))
    expect(comparison.extraModelCalls).toBe(2)
    expect(comparison.ticketsPerCall).toEqual({ dual: 0.25, single: 0.5 })
    expect(comparison.wallRatio).toBe(2)
    expect(comparison.verdict).toContain('extra model call')
  })

  it('handles a cheaper dual path and a zero-call baseline', () => {
    const cheaper = compareBakeoff(sample('dual', 3, 90), sample('single', 5, 100))
    expect(cheaper.extraModelCalls).toBe(-2)
    expect(cheaper.verdict).toContain('single-session paid')
    const zero = compareBakeoff(sample('dual', 2, 10), sample('single', 0, 10))
    expect(zero.ticketsPerCall.single).toBe(Number.POSITIVE_INFINITY)
  })
})

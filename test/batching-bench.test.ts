import fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { runBatchingStress } from '../src/metrics/batching-bench.ts'
import { readMetrics } from '../src/metrics/metrics.ts'
import { tempHome } from './fixtures.ts'

const dirs: string[] = []

function home(): string {
  const dir = tempHome()
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('T45 router batching stress curves', () => {
  it('folds same-Thread Triggers into one Eval per loaded round', () => {
    const result = runBatchingStress(home(), { triggersPerRound: 32, rounds: 3 })

    expect(result.submitted).toBe(96)
    expect(result.evalCount).toBe(3)
    expect(result.batchSizes).toEqual([32, 32, 32])
    expect(result.maxBatchSize).toBe(32)
    expect(result.foldRatio).toBe(32)

    expect(result.metrics.counters['ingress.admit']).toBe(96)
    expect(result.metrics.counters['eval.accept']).toBe(3)
    expect(result.latency.count).toBe(3)
  })

  it('persists one curve sample per Eval in metrics.json', () => {
    const dir = home()
    const result = runBatchingStress(dir, { triggersPerRound: 8, rounds: 5 })

    const persisted = readMetrics(dir)
    expect(persisted.curveSamples).toHaveLength(result.evalCount)
    expect(persisted.counters['eval.accept']).toBe(result.evalCount)
    expect(persisted.modelLatencyMs.count).toBe(result.evalCount)
  })

  it('collapses folding to a ratio of 1 when every Trigger is evaluated immediately', () => {
    const folded = runBatchingStress(home(), { triggersPerRound: 16, rounds: 2 })
    const immediate = runBatchingStress(home(), { triggersPerRound: 16, rounds: 2, fold: false })

    expect(folded.evalCount).toBe(2)
    expect(folded.foldRatio).toBe(16)
    expect(immediate.evalCount).toBe(32)
    expect(immediate.batchSizes.every(size => size === 1)).toBe(true)
    expect(immediate.foldRatio).toBe(1)
    expect(folded.evalCount).toBeLessThan(immediate.evalCount)
  })

  it('is deterministic in shape across runs (latency values may vary)', () => {
    const first = runBatchingStress(home(), { triggersPerRound: 12, rounds: 4 })
    const second = runBatchingStress(home(), { triggersPerRound: 12, rounds: 4 })

    expect(second.batchSizes).toEqual(first.batchSizes)
    expect(second.evalCount).toBe(first.evalCount)
    expect(second.foldRatio).toBe(first.foldRatio)
    expect(second.metrics.counters).toEqual(first.metrics.counters)
  })
})

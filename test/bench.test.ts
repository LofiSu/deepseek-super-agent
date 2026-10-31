import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { measureBatchPoint } from '../src/compare/batch.ts'
import { tempHome } from './fixtures.ts'

describe('batching benchmark', () => {
  it('collapses one thread into a single decision and keeps split threads apart', () => {
    const home = tempHome()
    const batched = measureBatchPoint('batched', 4, path.join(home, 'batched'))
    const split = measureBatchPoint('split', 4, path.join(home, 'split'))
    expect(batched.decisions).toBe(1)
    expect(batched.triggers).toBe(4)
    expect(split.decisions).toBe(4)
    expect(split.triggers).toBe(4)
    expect(batched.elapsedMs).toBeGreaterThanOrEqual(0)
  })
})
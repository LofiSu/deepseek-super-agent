import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { measureBatchPoint, type BatchPoint } from '../src/compare/batch.ts'

const sizes = [1, 8, 32, 128]
const modes: BatchPoint['mode'][] = ['batched', 'split']

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-bench-'))
console.log('batching benchmark — one Eval drain per row')
console.log('batched = one thread; split = one thread per trigger')
console.log('mode      size  decisions  triggers  ms')
for (const mode of modes) {
  for (const size of sizes) {
    const point = measureBatchPoint(mode, size, path.join(root, `${mode}-${size}`))
    const modeLabel = point.mode.padEnd(8, ' ')
    const sizeLabel = String(point.size).padStart(4, ' ')
    const decisions = String(point.decisions).padStart(9, ' ')
    const triggers = String(point.triggers).padStart(8, ' ')
    const ms = point.elapsedMs.toFixed(2).padStart(8, ' ')
    console.log(`${modeLabel} ${sizeLabel} ${decisions} ${triggers} ${ms}`)
  }
}
console.log(`home ${root}`)

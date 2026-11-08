import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256File, stableJsonDigest } from './digest.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** Immutable identity from evaluator source files (not a version string alone). */
export function computeEvaluatorDigest(): string {
  const files = [
    path.join(repoRoot, 'src/evolution/score.ts'),
    path.join(repoRoot, 'src/evolution/strategy-gate.ts'),
    path.join(repoRoot, 'src/evolution/safe-pattern.ts'),
    path.join(repoRoot, 'scripts/evolution-eval-child.mjs'),
  ]
  const parts = files.map(file => {
    if (!fs.existsSync(file)) throw new Error(`evaluator source missing: ${file}`)
    return { rel: path.relative(repoRoot, file), sha: sha256File(file) }
  })
  return stableJsonDigest(parts)
}

export const EVALUATOR_VERSION = 'evolution-evaluator-2' as const

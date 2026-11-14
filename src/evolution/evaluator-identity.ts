import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256File, stableJsonDigest } from './digest.ts'

export interface EvaluatorArtifactPaths {
  /** Checkout or package root: two levels above the evaluator module directory. */
  repoRoot: string
  score: string
  strategyGate: string
  safePattern: string
  childScript: string
}

function firstExisting(candidates: readonly string[]): string | undefined {
  return candidates.find(candidate => fs.existsSync(candidate))
}

function resolveModuleFile(moduleDir: string, base: string): string {
  const candidates = [path.join(moduleDir, `${base}.ts`), path.join(moduleDir, `${base}.js`)]
  const found = firstExisting(candidates)
  if (!found) throw new Error(`evaluator source missing: ${candidates.join(' or ')}`)
  return found
}

/**
 * Locate the trusted evaluator artifacts for both supported layouts:
 *
 * - source checkout: `src/evolution/*.ts` plus `<repo>/scripts/evolution-eval-child.mjs`
 * - published package: `dist/evolution/*.js` plus `<pkg>/dist/scripts/evolution-eval-child.mjs`
 *
 * A published install ships only `dist`, so the dist fallbacks never point into
 * `src/` or the package-root `scripts/` directory.
 */
export function resolveEvaluatorArtifacts(
  moduleDir: string = path.dirname(fileURLToPath(import.meta.url)),
): EvaluatorArtifactPaths {
  const repoRoot = path.resolve(moduleDir, '../..')
  const childCandidates = [
    path.resolve(moduleDir, '../../scripts/evolution-eval-child.mjs'),
    path.resolve(moduleDir, '../scripts/evolution-eval-child.mjs'),
  ]
  const childScript = firstExisting(childCandidates)
  if (!childScript) throw new Error(`evaluator source missing: ${childCandidates.join(' or ')}`)
  return {
    repoRoot,
    score: resolveModuleFile(moduleDir, 'score'),
    strategyGate: resolveModuleFile(moduleDir, 'strategy-gate'),
    safePattern: resolveModuleFile(moduleDir, 'safe-pattern'),
    childScript,
  }
}

/** Immutable identity from evaluator source files (not a version string alone). */
export function computeEvaluatorDigest(
  moduleDir: string = path.dirname(fileURLToPath(import.meta.url)),
): string {
  const artifacts = resolveEvaluatorArtifacts(moduleDir)
  // Order is part of the historical digest: score, strategy-gate, safe-pattern,
  // child. Source checkouts hash the .ts files; dist hashes the emitted .js.
  const files = [artifacts.score, artifacts.strategyGate, artifacts.safePattern, artifacts.childScript]
  const parts = files.map(file => {
    return { rel: path.relative(artifacts.repoRoot, file), sha: sha256File(file) }
  })
  return stableJsonDigest(parts)
}

export const EVALUATOR_VERSION = 'evolution-evaluator-2' as const

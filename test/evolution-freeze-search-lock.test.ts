import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultBaselineStrategy } from '../src/evolution/dataset.ts'
import { runEvolution } from '../src/evolution/evolve.ts'
import { freezeCandidate, loadExperiment } from '../src/evolution/experiment.ts'
import { acquireSearchRunLock, releaseSearchRunLock } from '../src/evolution/search-run-lock.ts'
import type { DeliverGateStrategyV1 } from '../src/evolution/types.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const datasetRoot = path.join(repoRoot, 'test/fixtures/evolution')

const budget = {
  maxCandidates: 4,
  maxEvals: 20,
  evalTimeoutMs: 20_000,
  reserveEvals: 2,
}

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-evo-freeze-lock-'))
  homes.push(home)
  return home
}

function withToken(token: string): DeliverGateStrategyV1 {
  const baseline = defaultBaselineStrategy()
  return { ...baseline, positiveTokens: [...baseline.positiveTokens!, token] }
}

function searchOnce(home: string, token: string, round = 1) {
  return runEvolution({
    home,
    datasetRoot,
    selector: 'simplified-greedy',
    stopOnFirstSuccess: false,
    injectCandidates: [withToken(token)],
    budget,
    round,
  })
}

describe('search and freeze are mutually exclusive', () => {
  it('re-checks lifecycle after acquiring the search lock (TOCTOU)', async () => {
    const home = tempHome()
    const first = await searchOnce(home, 'alphaunique')
    const winner = first.candidates.find(candidate => candidate.status === 'evaluated')
    expect(winner).toBeDefined()
    expect(loadExperiment(home)!.phase).toBe('search')

    const realOpenSync = fs.openSync
    let hookRan = false
    let usedEvalsAfterFreeze: number | null = null
    // Model the window between the pre-lock lifecycle check and lock
    // acquisition: freeze the evaluated candidate just before the second run
    // opens search-run.lock.
    ;(fs as { openSync: typeof fs.openSync }).openSync = ((
      file: fs.PathLike,
      flags: fs.OpenMode,
      ...rest: unknown[]
    ) => {
      const target = String(file)
      if (!hookRan && target.endsWith(`${path.sep}search-run.lock`) && flags === 'wx') {
        hookRan = true
        const frozen = freezeCandidate({
          home,
          candidateId: winner!.candidateId,
          runId: first.runId,
        })
        usedEvalsAfterFreeze = frozen.budget.usedEvals
      }
      return (realOpenSync as Function).call(fs, file, flags, ...rest)
    }) as typeof fs.openSync

    try {
      await expect(searchOnce(home, 'betaunique', 2)).rejects.toThrow(/frozen|search refused/)
    } finally {
      fs.openSync = realOpenSync
    }

    expect(hookRan).toBe(true)
    expect(usedEvalsAfterFreeze).not.toBeNull()
    const after = loadExperiment(home)!
    expect(after.phase).toBe('frozen')
    expect(after.selectedCandidateId).toBe(winner!.candidateId)
    // No baseline, candidate, or counter reservation landed after the freeze.
    expect(after.budget.usedEvals).toBe(usedEvalsAfterFreeze)
  })

  it('refuses to freeze while a search run holds the lock', async () => {
    const home = tempHome()
    const first = await searchOnce(home, 'alphaunique')
    const winner = first.candidates.find(candidate => candidate.status === 'evaluated')
    expect(winner).toBeDefined()

    const lock = acquireSearchRunLock(home)
    try {
      expect(() => freezeCandidate({
        home,
        candidateId: winner!.candidateId,
        runId: first.runId,
      })).toThrow(/search run lock/)
    } finally {
      releaseSearchRunLock(home, lock.lockToken)
    }

    expect(loadExperiment(home)!.phase).toBe('search')
    expect(loadExperiment(home)!.selectedCandidateId).toBeNull()
  })
})

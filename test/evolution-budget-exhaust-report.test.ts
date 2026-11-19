import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultBaselineStrategy } from '../src/evolution/dataset.ts'
import { runEvolution } from '../src/evolution/evolve.ts'
import { freezeCandidate, loadExperiment } from '../src/evolution/experiment.ts'
import type { DeliverGateStrategyV1 } from '../src/evolution/types.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const datasetRoot = path.join(repoRoot, 'test/fixtures/evolution')

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-evo-budget-report-'))
  homes.push(home)
  return home
}

function withToken(token: string): DeliverGateStrategyV1 {
  const baseline = defaultBaselineStrategy()
  return { ...baseline, positiveTokens: [...baseline.positiveTokens!, token] }
}

describe('search budget exhaustion still persists a run report', () => {
  it('evaluates one candidate, then reports instead of throwing when the next reservation fails', async () => {
    const home = tempHome()

    // Search pool = maxEvals - reserveEvals = 4. Baseline reserves 2 and the first
    // candidate reserves 2, so the second candidate's reservation exhausts the pool.
    const report = await runEvolution({
      home,
      datasetRoot,
      budget: { maxCandidates: 4, maxEvals: 6, evalTimeoutMs: 20_000, reserveEvals: 2 },
      stopOnFirstSuccess: false,
      selector: 'simplified-greedy',
      // `checkout` fixes the baseline's only train miss (tr-007) so the first
      // candidate passes the train gate; the second is never evaluated.
      injectCandidates: [withToken('checkout'), withToken('betaunique')],
    })

    const evaluated = report.candidates.filter(item => item.status === 'evaluated')
    expect(evaluated).toHaveLength(1)
    expect(evaluated[0]!.candidateId).toBe(report.candidates[0]!.candidateId)

    // The already-evaluated candidate was archived before the later reservation failed.
    const archived = path.join(
      home,
      'evolution',
      'archive',
      evaluated[0]!.candidateId,
      'candidate.json',
    )
    expect(fs.existsSync(archived)).toBe(true)

    // The run report is persisted so the candidate can be frozen.
    const runFile = path.join(home, 'evolution', 'runs', `${report.runId}.json`)
    expect(fs.existsSync(runFile)).toBe(true)

    const state = loadExperiment(home)!
    expect(state.totalCandidatesGenerated).toBe(1)
    expect(state.budget.usedEvals).toBe(4)
    expect(report.budget.usedEvals).toBe(4)

    const frozen = freezeCandidate({
      home,
      candidateId: evaluated[0]!.candidateId,
      runId: report.runId,
    })
    expect(frozen.selectedCandidateId).toBe(evaluated[0]!.candidateId)
  })
})

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IsolatedEvalResult } from '../src/evolution/isolate-eval.ts'

const dirs: string[] = []

afterEach(() => {
  vi.doUnmock('../src/evolution/isolate-eval.ts')
  vi.resetModules()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function writeDataset(root: string): void {
  fs.mkdirSync(root, { recursive: true })
  const splits = {
    train: { cases: [{ id: 'train-zeta', speculative: true, report: { kind: 'ready', text: 'zeta queue' }, expected: 'deliver' }] },
    validation: { cases: [{ id: 'validation-zeta', speculative: true, report: { kind: 'ready', text: 'zeta queue' }, expected: 'deliver' }] },
    finaltest: { cases: [{ id: 'final-zeta', speculative: true, report: { kind: 'ready', text: 'zeta queue' }, expected: 'deliver' }] },
  }
  for (const [name, value] of Object.entries(splits)) {
    fs.writeFileSync(path.join(root, `${name}.json`), JSON.stringify(value))
  }
  const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    schemaVersion: 2,
    domain: 'deliver-gate-v1',
    splits: { train: 'train.json', validation: 'validation.json', finaltest: 'finaltest.json' },
    splitDigests: {
      train: digest(path.join(root, 'train.json')),
      validation: digest(path.join(root, 'validation.json')),
      finaltest: digest(path.join(root, 'finaltest.json')),
    },
    seed: 17,
  }))
}

type Outcome = 'success' | 'child-error' | 'timeout'

function resultFor(outcome: Outcome, split: string): IsolatedEvalResult {
  if (outcome === 'timeout') return { launched: true, ok: false, timedOut: true, error: 'eval_timeout' }
  if (outcome === 'child-error') return { launched: true, ok: false, error: 'synthetic child failure' }
  return {
    launched: true,
    ok: true,
    score: { split: split as 'train' | 'validation' | 'finaltest', accuracy: 1, total: 1, correct: 1 },
  }
}

for (const outcome of ['success', 'child-error', 'timeout'] as const) {
  describe(`child launch accounting: ${outcome}`, () => {
    it('records spawned search and finaltest children on success, error, and timeout', async () => {
      const datasetRoot = tempDir('evo-launch-dataset-')
      writeDataset(datasetRoot)
      let activeOutcome: Outcome = outcome
      vi.doMock('../src/evolution/isolate-eval.ts', () => ({
        isolatedEvaluateSplit: async (_workDir: string, _strategy: unknown, split: string) => resultFor(activeOutcome, split),
      }))

      const { runEvolution } = await import('../src/evolution/evolve.ts')
      const { freezeCandidate, loadExperiment } = await import('../src/evolution/experiment.ts')
      const { runFinalTestOnce } = await import('../src/evolution/finalize.ts')
      const input = {
        datasetRoot,
        injectCandidates: [{
          schemaVersion: 2 as const,
          domain: 'deliver-gate-v1' as const,
          positiveTokens: ['zeta'],
          negativeTokens: ['cannot'],
          clauseLocalPositive: true,
        }],
        budget: { maxCandidates: 1, maxEvals: 10, evalTimeoutMs: 20_000, reserveEvals: 2 },
      }

      const searchHome = tempDir('evo-launch-search-home-')
      const searchReport = await runEvolution({ ...input, home: searchHome })
      expect(searchReport.budget.childEvalLaunches).toBe(outcome === 'success' ? 2 : 1)
      if (outcome !== 'success') {
        expect(searchReport.candidates[0]?.status).toBe(outcome === 'timeout' ? 'rejected_timeout' : 'rejected_eval_error')
      }

      // Establish a separate frozen experiment with successful search children,
      // then exercise the same outcome at the finaltest call site.
      const finalHome = tempDir('evo-launch-final-home-')
      activeOutcome = 'success'
      const finalReport = await runEvolution({ ...input, home: finalHome })
      const candidate = finalReport.candidates.find(item => item.status === 'evaluated')
      expect(candidate).toBeDefined()
      freezeCandidate({ home: finalHome, candidateId: candidate!.candidateId, runId: finalReport.runId })

      activeOutcome = outcome
      if (outcome === 'success') {
        await runFinalTestOnce({ home: finalHome, datasetRoot, candidateId: candidate!.candidateId })
      } else {
        await expect(runFinalTestOnce({ home: finalHome, datasetRoot, candidateId: candidate!.candidateId })).rejects.toThrow()
      }
      expect(loadExperiment(finalHome)!.budget.childEvalLaunches).toBe(3)
    })
  })
}

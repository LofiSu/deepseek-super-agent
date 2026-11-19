import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { writeSynthDataset } from '../src/evolution/synth-fixture.ts'
import { runEvolution } from '../src/evolution/evolve.ts'
import { freezeCandidate } from '../src/evolution/experiment.ts'
import { loadExperiment } from '../src/evolution/experiment.ts'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const homes: string[] = []
const datasets: string[] = []

afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true })
  for (const d of datasets.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

async function pipeline(home: string, datasetRoot: string) {
  const budget = { maxCandidates: 4, maxEvals: 24, evalTimeoutMs: 20_000, reserveEvals: 2, maxCandidatesThisRun: 1 }
  await runEvolution({
    home,
    datasetRoot,
    selector: 'simplified-greedy',
    stopOnFirstSuccess: false,
    budget,
  })
  const report = await runEvolution({
    home,
    datasetRoot,
    round: 2,
    selector: 'policy-memory',
    budget,
  })
  const winner = report.candidates.find(c => c.status === 'evaluated' && c.reward === 'success')
    ?? report.candidates.find(c => c.status === 'evaluated')
  if (!winner) throw new Error('no candidate')
  freezeCandidate({ home, candidateId: winner.candidateId, runId: report.runId })
  return { report, winner }
}

function spawnFinalizeAsync(
  home: string,
  datasetRoot: string,
  candidateId: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ ok: boolean; error?: string; stdout: string }> {
  return new Promise(resolve => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', path.join(repoRoot, 'scripts/finalize-once.ts'), home, datasetRoot, candidateId],
      {
        cwd: repoRoot,
        env: { ...process.env, CI: 'true', DS_AGENT_ALLOW_MOCK_FIXTURE: '1', ...extraEnv },
      },
    )
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.on('close', () => {
      const line = stdout.trim().split('\n').pop() ?? '{}'
      try {
        resolve({ ...JSON.parse(line), stdout })
      } catch {
        resolve({ ok: false, stdout, error: 'malformed' })
      }
    })
  })
}

function spawnFinalizeSync(home: string, datasetRoot: string, candidateId: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join(repoRoot, 'scripts/finalize-once.ts'), home, datasetRoot, candidateId],
    {
      cwd: repoRoot,
      env: { ...process.env, CI: 'true', DS_AGENT_ALLOW_MOCK_FIXTURE: '1', ...extraEnv },
      encoding: 'utf8',
    },
  )
}

describe('final test concurrent OS processes', () => {
  it('exactly one finalize succeeds under parallel spawn', async () => {
    const datasetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-conc-ds-'))
    datasets.push(datasetRoot)
    writeSynthDataset(datasetRoot)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-concurrent-'))
    homes.push(home)
    const { report, winner } = await pipeline(home, datasetRoot)

    const outs = await Promise.all([
      spawnFinalizeAsync(home, datasetRoot, winner.candidateId),
      spawnFinalizeAsync(home, datasetRoot, winner.candidateId),
    ])
    const okCount = outs.filter(o => o.ok).length
    expect(okCount).toBe(1)
    const fail = outs.find(o => !o.ok)
    expect(fail?.error ?? '').toMatch(/final test|claim|finalized|consumed/i)
    expect(report.runId).toBeDefined()
  })

  it('hang after claim leaves budget reserved; retry refused', async () => {
    const datasetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-fault-ds-'))
    datasets.push(datasetRoot)
    writeSynthDataset(datasetRoot)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-fault-finalize-'))
    homes.push(home)
    const { report, winner } = await pipeline(home, datasetRoot)

    const hung = spawnFinalizeSync(home, datasetRoot, winner.candidateId, {
      DS_AGENT_EVOLUTION_TEST_FAULT: 'hang_after_claim',
    })
    expect(hung.status).toBe(86)

    const exp = loadExperiment(home)!
    expect(exp.budget.finaltestReserved).toBe(true)

    const retry = spawnFinalizeSync(home, datasetRoot, winner.candidateId)
    const line = retry.stdout.trim().split('\n').pop() ?? '{}'
    const parsed = JSON.parse(line)
    expect(parsed.ok).toBe(false)
    expect(report.runId).toBeDefined()
  })
})

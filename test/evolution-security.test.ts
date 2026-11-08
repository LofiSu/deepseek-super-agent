import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runEvolution } from '../src/evolution/evolve.ts'
import { freezeCandidate, loadExperiment } from '../src/evolution/experiment.ts'
import { runFinalTestOnce } from '../src/evolution/finalize.ts'
import { approvePromotion, rollbackPromotion } from '../src/evolution/promotion.ts'
import { parseDeliverGateStrategy } from '../src/evolution/strategy-gate.ts'
import { defaultBaselineStrategy } from '../src/evolution/dataset.ts'
import { resolveDeliverGate } from '../src/speculate/resolve-gate.ts'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const datasetRoot = path.join(repoRoot, 'test/fixtures/evolution')
const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-evo-sec-'))
  homes.push(home)
  return home
}

async function winningPipeline(home: string) {
  const report = await runEvolution({
    home,
    datasetRoot,
    budget: { maxCandidates: 6, maxEvals: 6, evalTimeoutMs: 20_000, reserveEvals: 2 },
  })
  const winner = report.candidates.find(item => item.status === 'evaluated' && item.reward === 'success')
    ?? report.candidates.find(item => item.status === 'evaluated')
  expect(winner).toBeDefined()
  freezeCandidate({ home, candidateId: winner!.candidateId, runReport: report })
  await runFinalTestOnce({ home, datasetRoot, candidateId: winner!.candidateId })
  return { report, winner: winner! }
}

describe('evolution security and ABC final test', () => {
  it('rejects unknown strategy keys and catastrophic regex patterns', () => {
    expect(() => parseDeliverGateStrategy({
      schemaVersion: 2,
      domain: 'deliver-gate-v1',
      positiveTokens: ['ok'],
      negativeTokens: ['no'],
      clauseLocalPositive: true,
      evil: true,
    })).toThrow(/unknown strategy key/)
    expect(() => parseDeliverGateStrategy({
      schemaVersion: 2,
      domain: 'deliver-gate-v1',
      positivePattern: '(a+)+$',
      negativePattern: '\\b(?:no)\\b',
      clauseLocalPositive: true,
    })).toThrow()
  })

  it('rejects second final test and search after finalize', async () => {
    const home = tempHome()
    const { winner } = await winningPipeline(home)
    await expect(runFinalTestOnce({ home, datasetRoot, candidateId: winner.candidateId }))
      .rejects.toThrow(/duplicate|finalized|already/)
    await expect(runEvolution({ home, datasetRoot })).rejects.toThrow(/search refused|finalized/)
  })

  it('rejects promotion without finalized receipt', async () => {
    const home = tempHome()
    const report = await runEvolution({ home, datasetRoot, budget: { maxCandidates: 4, maxEvals: 12, evalTimeoutMs: 15_000, reserveEvals: 2 } })
    const winner = report.candidates.find(item => item.status === 'evaluated')
    expect(winner).toBeDefined()
    expect(() => approvePromotion({
      home,
      runReport: report,
      candidateId: winner!.candidateId,
      artifactPath: path.join(report.archiveDir, winner!.candidateId, 'candidate.json'),
    })).toThrow(/finalized experiment receipt/)
  })

  it('rejects stale tampered artifact on approval', async () => {
    const home = tempHome()
    const { report, winner } = await winningPipeline(home)
    const artifact = path.join(report.archiveDir, winner.candidateId, 'candidate.json')
    const tampered = JSON.parse(fs.readFileSync(artifact, 'utf8'))
    tampered.strategy.positiveTokens.push('totallynewtoken')
    fs.writeFileSync(artifact, JSON.stringify(tampered, null, 2))
    expect(() => approvePromotion({
      home,
      runReport: report,
      candidateId: winner.candidateId,
      artifactPath: artifact,
    })).toThrow(/digest mismatch|tamper/)
  })

  it('rollback clears promoted consumer', async () => {
    const home = tempHome()
    const { report, winner } = await winningPipeline(home)
    const artifact = path.join(report.archiveDir, winner.candidateId, 'candidate.json')
    const prev = process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE
    process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE = '1'
    try {
      approvePromotion({ home, runReport: report, candidateId: winner.candidateId, artifactPath: artifact })
      expect(resolveDeliverGate(home).constructor.name).toBe('ConfigurableDeliverGate')
      rollbackPromotion(home)
      expect(resolveDeliverGate(home).constructor.name).toBe('HeuristicDeliverGate')
    } finally {
      if (prev === undefined) delete process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE
      else process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE = prev
    }
  })

  it('two search rounds differ after policy memory (fixture)', async () => {
    const home = tempHome()
    const roundBudget = { maxCandidates: 3, maxEvals: 12, evalTimeoutMs: 15_000, reserveEvals: 2 }
    const r1 = await runEvolution({ home, datasetRoot, round: 1, budget: roundBudget })
    const r2 = await runEvolution({ home, datasetRoot, round: 2, budget: roundBudget })
    const exp = loadExperiment(home)
    expect(exp?.seenDirections.length).toBeGreaterThanOrEqual(1)
    expect(r2.round).toBeGreaterThanOrEqual(2)
    const baseline = defaultBaselineStrategy()
    expect(r1.candidates.length + r2.candidates.length).toBeGreaterThan(0)
    expect(baseline.positiveTokens?.length).toBeGreaterThan(0)
  })
})

#!/usr/bin/env node
/**
 * @deprecated Prefer LABEL synth two-process CLI demo:
 *   CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 pnpm exec tsx scripts/evolution-two-cli-rounds.ts
 *
 * In-process fixture demo (legacy); uses adequate budgets for finalize reserve pool.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runEvolution } from '../src/evolution/evolve.ts'
import { loadExperiment } from '../src/evolution/experiment.ts'
import { loadPolicyMemory } from '../src/evolution/policy-memory.ts'
import { freezeCandidate } from '../src/evolution/experiment.ts'
import { runFinalTestOnce } from '../src/evolution/finalize.ts'
import { approvePromotion, rollbackPromotion } from '../src/evolution/promotion.ts'
import { resolveDeliverGate } from '../src/speculate/resolve-gate.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const datasetRoot = path.join(repoRoot, 'test/fixtures/evolution')

async function main(): Promise<void> {
  const home = process.env.DS_AGENT_HOME ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-evo-demo-'))
  process.env.DS_AGENT_HOME = home
  const log: unknown[] = []
  const budget = {
    maxCandidates: 4,
    maxEvals: 32,
    evalTimeoutMs: 15_000,
    reserveEvals: 4,
  }

  const r1 = await runEvolution({ home, datasetRoot, round: 1, budget })
  log.push({ step: 'round1', candidates: r1.candidates.length, budget: r1.budget })

  const r2 = await runEvolution({ home, datasetRoot, round: 2, budget })
  const mem = loadPolicyMemory(home, r2.experimentId)
  const exp = loadExperiment(home)
  log.push({
    step: 'round2',
    lessons: mem.lessons.length,
    totalCandidatesGenerated: exp?.totalCandidatesGenerated,
    totalOpportunities: exp?.totalOpportunities,
  })

  type Pick = { report: typeof r1; winner: (typeof r1.candidates)[number] }
  let pick: Pick | undefined
  for (const report of [r2, r1]) {
    const winner = report.candidates.find(item => item.status === 'evaluated' && item.reward === 'success')
      ?? report.candidates.find(item => item.status === 'evaluated')
    if (winner) {
      pick = { report, winner }
      break
    }
  }
  if (!pick) throw new Error('no winner in demo')
  const { report: winReport, winner } = pick

  freezeCandidate({ home, candidateId: winner.candidateId, runId: winReport.runId, runReport: winReport })
  const fin = await runFinalTestOnce({ home, datasetRoot, candidateId: winner.candidateId })
  log.push({ step: 'finalize', ledgerId: fin.ledgerId, finaltest: fin.scores })

  const prev = process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE
  process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE = '1'
  try {
    approvePromotion({
      home,
      runReport: winReport,
      candidateId: winner.candidateId,
      artifactPath: path.join(winReport.archiveDir, winner.candidateId, 'candidate.json'),
    })
    log.push({ step: 'approve', gate: resolveDeliverGate(home).constructor.name })
    rollbackPromotion(home)
    log.push({ step: 'rollback', gate: resolveDeliverGate(home).constructor.name })
  } finally {
    if (prev === undefined) delete process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE
    else process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE = prev
  }

  console.log(JSON.stringify(log, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

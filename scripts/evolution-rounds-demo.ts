#!/usr/bin/env node
/**
 * Two-round + restart demo (LABEL fixture). Writes JSON steps to stdout.
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

  const r1 = await runEvolution({
    home,
    datasetRoot,
    round: 1,
    budget: { maxCandidates: 4, maxEvals: 4, evalTimeoutMs: 15_000, reserveEvals: 2 },
  })
  log.push({ step: 'round1', candidates: r1.candidates.length, budget: r1.budget })

  const r2 = await runEvolution({
    home,
    datasetRoot,
    round: 2,
    budget: { maxCandidates: 4, maxEvals: 4, evalTimeoutMs: 15_000, reserveEvals: 2 },
  })
  const mem = loadPolicyMemory(home, r2.experimentId)
  log.push({
    step: 'round2',
    lessons: mem.lessons.length,
    round2Directions: r2.candidates.map(item => item.directionKey),
  })

  const expPath = path.join(home, 'evolution', 'experiment.json')
  const saved = JSON.parse(fs.readFileSync(expPath, 'utf8'))
  fs.writeFileSync(expPath + '.bak', JSON.stringify(saved))

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

  freezeCandidate(home, winner.candidateId)
  const fin = runFinalTestOnce({ home, datasetRoot, candidateId: winner.candidateId })
  log.push({ step: 'finalize', ledgerId: fin.ledgerId, finaltest: fin.scores })

  try {
    runFinalTestOnce({ home, datasetRoot, candidateId: winner.candidateId })
  } catch (error) {
    log.push({ step: 'finalize_retry_rejected', error: error instanceof Error ? error.message : String(error) })
  }

  const prev = process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE
  process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE = '1'
  try {
    const artifact = path.join(winReport.archiveDir, winner.candidateId, 'candidate.json')
    approvePromotion({
      home,
      runReport: winReport,
      candidateId: winner.candidateId,
      artifactPath: artifact,
    })
    log.push({ step: 'approve', gate: resolveDeliverGate(home).constructor.name })
    rollbackPromotion(home)
    log.push({ step: 'rollback', gate: resolveDeliverGate(home).constructor.name })
  } finally {
    if (prev === undefined) delete process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE
    else process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE = prev
  }

  log.push({ step: 'restart_reload', experiment: loadExperiment(home)?.phase, policyRound: mem.round, home })
  console.log(JSON.stringify(log, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

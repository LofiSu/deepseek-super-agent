import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadFinaltestSplit } from './dataset.ts'
import {
  claimFinalTest,
  loadExperiment,
  markFinalTestConsumed,
  markFinalTestRunning,
  openFinalTestLedger,
  recordFinalTest,
} from './experiment.ts'
import { computeEvaluatorDigest } from './evaluator-identity.ts'
import { reserveFinalTestUnits } from './budget-ledger.ts'
import { evolutionArchiveRoot } from './archive.ts'
import { readJsonFile, resolveInsideDir } from './io.ts'
import type { EvolutionCandidateRecord, SplitScore } from './types.ts'
import { parseDeliverGateStrategy } from './strategy-gate.ts'
import { isolatedEvaluateSplit } from './isolate-eval.ts'
import { sha256File, stableJsonDigest } from './digest.ts'

export function loadCandidateArtifact(home: string, candidateId: string): EvolutionCandidateRecord {
  if (!/^[a-zA-Z0-9_.-]+$/.test(candidateId)) throw new Error('invalid candidate id')
  const archiveRoot = evolutionArchiveRoot(home)
  const artifact = path.join(archiveRoot, candidateId, 'candidate.json')
  const resolved = resolveInsideDir(archiveRoot, artifact)
  return readJsonFile<EvolutionCandidateRecord>(resolved)
}

/** One-shot sealed split C evaluation; never re-used for search gates. */
export async function runFinalTestOnce(input: {
  home: string
  datasetRoot: string
  candidateId: string
}): Promise<{ scores: SplitScore[]; ledgerId: string }> {
  const experimentBefore = loadExperiment(input.home)
  if (!experimentBefore) throw new Error('missing experiment')
  if (experimentBefore.phase === 'finalized' && experimentBefore.finalTest !== null) {
    throw new Error('final test already finalized')
  }
  if (experimentBefore.finalTest !== null) throw new Error('duplicate final test open rejected')
  if (experimentBefore.selectedCandidateId !== input.candidateId) {
    throw new Error('candidate not frozen selection')
  }

  claimFinalTest(input.home, input.candidateId)
  reserveFinalTestUnits(input.home)
  markFinalTestRunning(input.home)

  const experiment = loadExperiment(input.home)!
  const evaluatorDigest = computeEvaluatorDigest()
  if (evaluatorDigest !== experiment.evaluatorDigest) {
    markFinalTestConsumed(input.home, false)
    throw new Error('evaluator digest drift; refuse final test')
  }

  const artifact = loadCandidateArtifact(input.home, input.candidateId)
  let strategy
  try {
    strategy = parseDeliverGateStrategy(artifact.strategy)
  } catch (error) {
    markFinalTestConsumed(input.home, false)
    throw error
  }
  const strategyDigest = stableJsonDigest(strategy)
  if (strategyDigest !== artifact.strategyDigest
    || strategyDigest !== experiment.frozenSelection?.strategyDigest) {
    markFinalTestConsumed(input.home, false)
    throw new Error('artifact strategy digest mismatch')
  }

  const finaltest = loadFinaltestSplit(input.datasetRoot)
  const manifest = JSON.parse(fs.readFileSync(path.join(input.datasetRoot, 'manifest.json'), 'utf8'))
  const finaltestFile = path.join(input.datasetRoot, manifest.splits.finaltest)
  const onDiskFinalDigest = sha256File(finaltestFile)
  if (onDiskFinalDigest !== manifest.splitDigests.finaltest) {
    markFinalTestConsumed(input.home, false)
    throw new Error('finaltest file digest mismatch vs manifest')
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-finaltest-'))
  let score: SplitScore
  try {
    const result = await isolatedEvaluateSplit(
      workDir,
      strategy,
      'finaltest',
      finaltest,
      experiment.budget,
    )
    if (result.timedOut || !result.ok || !result.score) {
      markFinalTestConsumed(input.home, false)
      throw new Error(result.error ?? 'finaltest_eval_failed')
    }
    score = result.score.split === 'finaltest'
      ? result.score
      : { ...result.score, split: 'finaltest' }
  } catch (error) {
    markFinalTestConsumed(input.home, false)
    throw error
  }

  const ledger = openFinalTestLedger(input.candidateId, {
    strategyDigest,
    datasetDigest: experiment.datasetDigest,
    evaluatorDigest,
  })
  ledger.scores = [score]
  ledger.closedAt = new Date().toISOString()
  recordFinalTest(input.home, ledger)
  markFinalTestConsumed(input.home, true)
  return { scores: [score], ledgerId: ledger.ledgerId }
}

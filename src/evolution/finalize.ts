import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSearchDatasetOnly, loadFinaltestSplit } from './dataset.ts'
import {
  abortFinalTestClaim,
  claimFinalTest,
  loadExperiment,
  markFinalTestConsumed,
  markFinalTestRunning,
  openFinalTestLedger,
  recordFinalTest,
} from './experiment.ts'
import { computeEvaluatorDigest } from './evaluator-identity.ts'
import { recordChildEvalLaunch, reserveFinalTestUnits } from './budget-ledger.ts'
import { evolutionArchiveRoot } from './archive.ts'
import { readJsonFile, resolveInsideDir } from './io.ts'
import type { EvolutionCandidateRecord, SplitScore } from './types.ts'
import { parseDeliverGateStrategy } from './strategy-gate.ts'
import { isolatedEvaluateSplit } from './isolate-eval.ts'
import { sealArtifactDigest } from './archive.ts'
import { stableJsonDigest } from './digest.ts'
import { assertEvolutionTestFault } from './test-fault.ts'

export function loadCandidateArtifact(home: string, candidateId: string): EvolutionCandidateRecord {
  if (!/^[a-zA-Z0-9_.-]+$/.test(candidateId)) throw new Error('invalid candidate id')
  const archiveRoot = evolutionArchiveRoot(home)
  const artifact = path.join(archiveRoot, candidateId, 'candidate.json')
  const resolved = resolveInsideDir(archiveRoot, artifact)
  const record = readJsonFile<EvolutionCandidateRecord>(resolved, archiveRoot)
  const sealed = sealArtifactDigest(record)
  if (record.artifactDigest !== sealed) {
    throw new Error('artifact full seal mismatch at finalization')
  }
  return record
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

  const { lockToken } = claimFinalTest(input.home, input.candidateId)

  try {
    const searchDataset = loadSearchDatasetOnly(input.datasetRoot)
    const experiment = loadExperiment(input.home)!
    if (searchDataset.datasetDigest !== experiment.datasetDigest) {
      abortFinalTestClaim(input.home, lockToken, 'dataset digest mismatch vs preregistered experiment')
    }

    reserveFinalTestUnits(input.home)
    assertEvolutionTestFault(input.home, 'hang_after_claim')

    let artifact: EvolutionCandidateRecord
    try {
      artifact = loadCandidateArtifact(input.home, input.candidateId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      abortFinalTestClaim(input.home, lockToken, message)
    }

    if (artifact.artifactDigest !== experiment.frozenSelection?.artifactDigest) {
      abortFinalTestClaim(input.home, lockToken, 'frozen artifact digest mismatch')
    }

    markFinalTestRunning(input.home)

    const evaluatorDigest = computeEvaluatorDigest()
    if (evaluatorDigest !== experiment.evaluatorDigest) {
      abortFinalTestClaim(input.home, lockToken, 'evaluator digest drift; refuse final test')
    }

    let strategy
    try {
      strategy = parseDeliverGateStrategy(artifact.strategy)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      abortFinalTestClaim(input.home, lockToken, message)
    }
    const strategyDigest = stableJsonDigest(strategy)
    if (strategyDigest !== artifact.strategyDigest
      || strategyDigest !== experiment.frozenSelection?.strategyDigest) {
      abortFinalTestClaim(input.home, lockToken, 'artifact strategy digest mismatch')
    }

    const finaltest = loadFinaltestSplit(input.datasetRoot)

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
        abortFinalTestClaim(input.home, lockToken, result.error ?? 'finaltest_eval_failed')
      }
      recordChildEvalLaunch(input.home, 1)
      score = result.score.split === 'finaltest'
        ? result.score
        : { ...result.score, split: 'finaltest' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      abortFinalTestClaim(input.home, lockToken, message)
    }

    const ledger = openFinalTestLedger(input.candidateId, {
      strategyDigest,
      datasetDigest: experiment.datasetDigest,
      evaluatorDigest,
    })
    ledger.scores = [score]
    ledger.closedAt = new Date().toISOString()
    recordFinalTest(input.home, ledger)
    markFinalTestConsumed(input.home, true, lockToken)
    return { scores: [score], ledgerId: ledger.ledgerId }
  } catch (error) {
    if (error instanceof Error && error.message.includes('final test claim')) throw error
    throw error
  }
}

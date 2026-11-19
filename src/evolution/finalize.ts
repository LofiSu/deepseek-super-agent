import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertPreregisteredFinaltestCommitment,
  loadCommittedFinaltestSplit,
  loadSearchDatasetOnly,
} from './dataset.ts'
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
import { recordFinalTestChildEvalLaunch, reserveFinalTestUnits } from './budget-ledger.ts'
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
  const experiment = loadExperiment(input.home)
  if (!experiment) throw new Error('missing experiment')
  if (experiment.phase === 'finalized' && experiment.finalTest !== null) {
    throw new Error('final test already finalized')
  }
  if (experiment.finalTest !== null) throw new Error('duplicate final test open rejected')
  if (experiment.selectedCandidateId !== input.candidateId) {
    throw new Error('candidate not frozen selection')
  }

  // Request preconditions below never parse or return finaltest cases, so they
  // run before the one-shot claim. A rejection here (a wrong or omitted
  // --dataset, a tampered artifact, evaluator drift) must leave the experiment
  // frozen and claimable, not burn the claim that seals the holdout read.
  const searchDataset = loadSearchDatasetOnly(input.datasetRoot)
  if (searchDataset.datasetDigest !== experiment.datasetDigest) {
    throw new Error('dataset digest mismatch vs preregistered experiment')
  }
  assertPreregisteredFinaltestCommitment(searchDataset)

  const artifact = loadCandidateArtifact(input.home, input.candidateId)
  if (artifact.artifactDigest !== experiment.frozenSelection?.artifactDigest) {
    throw new Error('frozen artifact digest mismatch')
  }

  const strategy = parseDeliverGateStrategy(artifact.strategy)
  const strategyDigest = stableJsonDigest(strategy)
  if (strategyDigest !== artifact.strategyDigest
    || strategyDigest !== experiment.frozenSelection?.strategyDigest) {
    throw new Error('artifact strategy digest mismatch')
  }

  const evaluatorDigest = computeEvaluatorDigest()
  if (evaluatorDigest !== experiment.evaluatorDigest) {
    throw new Error('evaluator digest drift; refuse final test')
  }

  // Every precondition is satisfied; only now open the one-shot claim. Failures
  // from here on happen while opening or scoring the sealed holdout and must
  // still abort and consume the claim.
  const { lockToken } = claimFinalTest(input.home, input.candidateId)

  try {
    reserveFinalTestUnits(input.home)
    assertEvolutionTestFault(input.home, 'hang_after_claim')
    markFinalTestRunning(input.home)

    let finaltest: ReturnType<typeof loadCommittedFinaltestSplit>
    try {
      finaltest = loadCommittedFinaltestSplit(searchDataset)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      abortFinalTestClaim(input.home, lockToken, message)
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
      if (result.launched) recordFinalTestChildEvalLaunch(input.home, 1)
      if (result.timedOut || !result.ok || !result.score) {
        abortFinalTestClaim(input.home, lockToken, result.error ?? 'finaltest_eval_failed')
      }
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
    // Any post-claim throw that did not take an explicit abort path above (for
    // example reserveFinalTestUnits or markFinalTestRunning) must not leave the
    // one-shot claim open with an unconsumed OS lock. A throw that already went
    // through abortFinalTestClaim has marked the claim FAILED and consumed the
    // lock, so rethrow it untouched instead of aborting a second time.
    const state = loadExperiment(input.home)
    const claimState = state?.finalTestClaim?.state
    if (claimState === 'CLAIMED' || claimState === 'RUNNING') {
      const message = error instanceof Error ? error.message : String(error)
      abortFinalTestClaim(input.home, lockToken, message)
    }
    throw error
  }
}

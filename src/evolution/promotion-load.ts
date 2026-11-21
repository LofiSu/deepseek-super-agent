import fs from 'node:fs'
import path from 'node:path'
import { parseDeliverGateStrategy } from './strategy-gate.ts'
import { stableJsonDigest } from './digest.ts'
import type { DeliverGateStrategyV1, EvolutionCandidateRecord, PromotionRecord } from './types.ts'
import { PROMOTED_STRATEGY_FILE, promotionRecordPath } from './promotion.ts'
import { resolveInsideDir, resolveTrustedEvolutionRoot } from './io.ts'
import { evolutionArchiveRoot } from './archive.ts'
import { sealArtifactDigest } from './archive.ts'
import { loadExperiment, loadFrozenRunReceipt } from './experiment.ts'
import { computeEvaluatorDigest } from './evaluator-identity.ts'
import { readJsonFile } from './io.ts'

export function loadPromotedStrategy(home: string): DeliverGateStrategyV1 | null {
  const evolutionRoot = resolveTrustedEvolutionRoot(home)
  const recordFile = promotionRecordPath(home)
  const strategyFile = path.join(evolutionRoot, PROMOTED_STRATEGY_FILE)
  if (!fs.existsSync(recordFile)) return null
  if (!fs.existsSync(strategyFile)) return null

  const record = readJsonFile<PromotionRecord>(recordFile, evolutionRoot)
  resolveInsideDir(evolutionRoot, strategyFile)

  const experiment = loadExperiment(home)
  if (!experiment || experiment.phase !== 'finalized' || !experiment.finalTest) {
    throw new Error('promotion consumer requires finalized experiment receipt')
  }
  if (record.experimentId !== experiment.experimentId) {
    throw new Error('promotion experiment id mismatch')
  }
  if (record.datasetDigest !== experiment.datasetDigest
    || record.datasetDigest !== experiment.finalTest.datasetDigest) {
    throw new Error('promotion dataset digest mismatch')
  }

  const evaluatorDigest = computeEvaluatorDigest()
  if (evaluatorDigest !== record.evaluatorDigest
    || evaluatorDigest !== experiment.evaluatorDigest
    || evaluatorDigest !== experiment.finalTest.evaluatorDigest) {
    throw new Error('promotion evaluator digest mismatch')
  }
  if (record.finalTestLedgerId !== experiment.finalTest.ledgerId) {
    throw new Error('promotion final test ledger mismatch')
  }

  const receipt = loadFrozenRunReceipt(home)
  if (!receipt || receipt.runId !== record.runId) {
    throw new Error('promotion missing frozen run receipt on disk')
  }
  if (receipt.datasetDigest !== record.datasetDigest || receipt.evaluatorDigest !== record.evaluatorDigest) {
    throw new Error('frozen run receipt digest mismatch vs promotion')
  }

  // Re-apply the same admission gates approvePromotion enforces, against the
  // experiment-sealed frozen receipt. Promotion artifacts on disk are only as
  // trustworthy as the experiment state that admitted them, so a planted
  // promotion record or a swapped on-disk receipt cannot activate a candidate
  // the experiment itself would have refused.
  const sealedReport = experiment.frozenRunReceipt
  if (!sealedReport) {
    throw new Error('promotion consumer requires the experiment-sealed frozen run receipt')
  }
  if (stableJsonDigest(receipt) !== stableJsonDigest(sealedReport)) {
    throw new Error('frozen run receipt does not match the experiment-sealed receipt')
  }

  const candidate = sealedReport.candidates.find(item => item.candidateId === record.candidateId)
  if (!candidate) {
    throw new Error(`promotion unknown candidate ${record.candidateId}`)
  }
  if (candidate.status !== 'evaluated') {
    throw new Error(`promotion candidate status=${candidate.status}; cannot load`)
  }
  if (candidate.reward !== 'success') {
    throw new Error(`train gate not satisfied; promotion refused (reward=${candidate.reward})`)
  }
  const validation = candidate.scores.find(score => score.split === 'validation')
  if (!validation || validation.accuracy < 1) {
    throw new Error('validation gate not satisfied; promotion refused')
  }
  const finalScore = experiment.finalTest.scores.find(score => score.split === 'finaltest')
  if (!finalScore || finalScore.total < 1 || finalScore.accuracy < 1) {
    throw new Error('final test gate not satisfied; promotion refused')
  }

  const raw = readJsonFile<unknown>(strategyFile, evolutionRoot)
  const strategy = parseDeliverGateStrategy(raw)
  const strategyDigest = stableJsonDigest(strategy)
  if (strategyDigest !== record.strategyDigest
    || strategyDigest !== experiment.finalTest.strategyDigest) {
    throw new Error('promoted strategy digest mismatch vs promotion record')
  }

  if (!record.artifactPath || !fs.existsSync(record.artifactPath)) {
    throw new Error('promotion record missing artifact path')
  }

  const archiveRoot = evolutionArchiveRoot(home)
  const resolvedArtifact = resolveInsideDir(archiveRoot, record.artifactPath)
  const artifact = readJsonFile<EvolutionCandidateRecord>(resolvedArtifact, archiveRoot)
  const sealed = sealArtifactDigest(artifact)
  if (artifact.candidateId !== record.candidateId) {
    throw new Error('promotion artifact candidateId mismatch')
  }
  if (artifact.strategyDigest !== record.strategyDigest) {
    throw new Error('promotion artifact strategy digest mismatch')
  }
  if (!artifact.artifactDigest || artifact.artifactDigest !== record.artifactDigest || sealed !== record.artifactDigest) {
    throw new Error('promotion artifact full seal mismatch (tamper)')
  }

  return strategy
}

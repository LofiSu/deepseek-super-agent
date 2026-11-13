import fs from 'node:fs'
import path from 'node:path'
import { parseDeliverGateStrategy } from './strategy-gate.ts'
import { sha256File, stableJsonDigest } from './digest.ts'
import { sealArtifactDigest } from './archive.ts'
import type { EvolutionCandidateRecord, EvolutionRunReport, PromotionRecord } from './types.ts'
import { writeJsonAtomic } from './io.ts'
import { loadExperiment, loadFrozenRunReceipt, loadPersistedRunReport } from './experiment.ts'
import { computeEvaluatorDigest } from './evaluator-identity.ts'
export { loadPromotedStrategy } from './promotion-load.ts'

export const PROMOTED_STRATEGY_FILE = 'deliver-gate.strategy.json'

export function promotedStrategyPath(home: string): string {
  return path.join(home, 'evolution', PROMOTED_STRATEGY_FILE)
}

export function promotionRecordPath(home: string): string {
  return path.join(home, 'evolution', 'promotion.json')
}

function resolveInside(home: string, artifactPath: string): string {
  const evolutionRoot = path.join(home, 'evolution')
  fs.mkdirSync(evolutionRoot, { recursive: true })
  const evolutionReal = fs.realpathSync(evolutionRoot)
  const resolved = fs.realpathSync(path.resolve(artifactPath))
  if (!resolved.startsWith(evolutionReal + path.sep) && resolved !== evolutionReal) {
    throw new Error('artifact path outside evolution home (reject tamper/symlink escape)')
  }
  if (path.basename(resolved) !== 'candidate.json') {
    throw new Error('artifact must be candidate.json')
  }
  return resolved
}

export function approvePromotion(input: {
  home: string
  runReport: EvolutionRunReport
  candidateId: string
  artifactPath: string
}): PromotionRecord {
  const experiment = loadExperiment(input.home)
  if (!experiment) throw new Error('missing experiment state')
  if (experiment.phase !== 'finalized' || !experiment.finalTest) {
    throw new Error('finalized experiment receipt required before promotion')
  }
  if (experiment.finalTest.candidateId !== input.candidateId) {
    throw new Error('final test candidate mismatch')
  }
  const runReport = loadPersistedRunReport(input.home, input.runReport.runId)
  const evaluatorDigest = computeEvaluatorDigest()
  if (evaluatorDigest !== experiment.evaluatorDigest
    || evaluatorDigest !== runReport.evaluatorDigest) {
    throw new Error('evaluator digest mismatch')
  }
  if (stableJsonDigest(runReport) !== stableJsonDigest(input.runReport)) {
    throw new Error('run report does not match persisted artifact')
  }
  if (runReport.datasetDigest !== experiment.datasetDigest) {
    throw new Error('dataset digest mismatch')
  }
  const frozenReceipt = loadFrozenRunReceipt(input.home)
  if (!frozenReceipt || frozenReceipt.runId !== runReport.runId) {
    throw new Error('frozen run receipt missing or mismatched')
  }

  const candidate = runReport.candidates.find(item => item.candidateId === input.candidateId)
  if (!candidate) throw new Error(`unknown candidate ${input.candidateId}`)
  if (candidate.status !== 'evaluated') {
    throw new Error(`candidate ${input.candidateId} status=${candidate.status}; cannot promote`)
  }
  if (candidate.reward !== 'success') {
    throw new Error(`train gate not satisfied; promotion refused (reward=${candidate.reward})`)
  }

  const resolvedArtifact = resolveInside(input.home, input.artifactPath)
  const onDisk = JSON.parse(fs.readFileSync(resolvedArtifact, 'utf8')) as EvolutionCandidateRecord
  if (onDisk.candidateId !== candidate.candidateId) {
    throw new Error('artifact candidateId mismatch')
  }
  const expectedArtifactDigest = sealArtifactDigest(onDisk)
  if (!onDisk.artifactDigest || onDisk.artifactDigest !== expectedArtifactDigest) {
    throw new Error('artifact content digest mismatch (tamper)')
  }

  const strategy = parseDeliverGateStrategy(onDisk.strategy)
  const strategyDigest = stableJsonDigest(strategy)
  if (strategyDigest !== candidate.strategyDigest
    || strategyDigest !== experiment.finalTest.strategyDigest) {
    throw new Error('strategy digest mismatch (stale or tampered)')
  }

  const validation = candidate.scores.find(score => score.split === 'validation')
  if (!validation || validation.accuracy < 1) {
    throw new Error('validation gate not satisfied; promotion refused')
  }

  const finalScore = experiment.finalTest.scores.find(score => score.split === 'finaltest')
  if (!finalScore || finalScore.total < 1 || finalScore.accuracy < 1) {
    throw new Error('final test gate not satisfied; promotion refused')
  }

  writeJsonAtomic(promotedStrategyPath(input.home), strategy)
  const record: PromotionRecord = {
    approvedAt: new Date().toISOString(),
    strategyDigest,
    artifactDigest: onDisk.artifactDigest,
    datasetDigest: experiment.datasetDigest,
    evaluatorDigest,
    artifactPath: resolvedArtifact,
    runId: runReport.runId,
    candidateId: candidate.candidateId,
    experimentId: experiment.experimentId,
    finalTestLedgerId: experiment.finalTest.ledgerId,
  }
  writeJsonAtomic(promotionRecordPath(input.home), record)
  return record
}

export function rollbackPromotion(home: string): { rolledBack: boolean; previousDigest: string | null } {
  const promoted = promotedStrategyPath(home)
  const recordFile = promotionRecordPath(home)
  let previousDigest: string | null = null
  if (fs.existsSync(promoted)) {
    previousDigest = sha256File(promoted)
    fs.unlinkSync(promoted)
  }
  if (fs.existsSync(recordFile)) fs.unlinkSync(recordFile)
  if (fs.existsSync(`${promoted}.sha256`)) fs.unlinkSync(`${promoted}.sha256`)
  return { rolledBack: true, previousDigest }
}

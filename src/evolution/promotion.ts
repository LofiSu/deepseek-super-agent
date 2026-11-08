import fs from 'node:fs'
import path from 'node:path'
import { parseDeliverGateStrategy } from './strategy-gate.ts'
import { sha256File } from './digest.ts'
import { stableJsonDigest } from './digest.ts'
import type { DeliverGateStrategyV1, EvolutionCandidateRecord, EvolutionRunReport } from './types.ts'

export const PROMOTED_STRATEGY_FILE = 'deliver-gate.strategy.json'

export function promotedStrategyPath(home: string): string {
  return path.join(home, 'evolution', PROMOTED_STRATEGY_FILE)
}

export function promotionRecordPath(home: string): string {
  return path.join(home, 'evolution', 'promotion.json')
}

export interface PromotionRecord {
  approvedAt: string
  strategyDigest: string
  artifactPath: string
  runId: string
  candidateId: string
}

function resolveInside(home: string, artifactPath: string): string {
  const evolutionRoot = path.join(home, 'evolution')
  const resolved = fs.realpathSync(path.resolve(artifactPath))
  const rootResolved = fs.realpathSync(evolutionRoot)
  if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
    throw new Error('artifact path outside evolution home (reject tamper/symlink escape)')
  }
  return resolved
}

export function loadPromotedStrategy(home: string): DeliverGateStrategyV1 | null {
  const file = promotedStrategyPath(home)
  if (!fs.existsSync(file)) return null
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  return parseDeliverGateStrategy(raw)
}

/**
 * Human-approved promotion: binds exact digest of evaluated artifact on disk.
 * Does not touch git, main branch, or deploy targets.
 */
export function approvePromotion(input: {
  home: string
  runReport: EvolutionRunReport
  candidateId: string
  artifactPath: string
}): PromotionRecord {
  const candidate = input.runReport.candidates.find(item => item.candidateId === input.candidateId)
  if (!candidate) throw new Error(`unknown candidate ${input.candidateId}`)
  if (candidate.status !== 'evaluated') {
    throw new Error(`candidate ${input.candidateId} status=${candidate.status}; cannot promote`)
  }
  const resolvedArtifact = resolveInside(input.home, input.artifactPath)
  if (path.basename(resolvedArtifact) !== 'candidate.json') {
    throw new Error('artifact must be archive .../candidate.json')
  }
  const onDisk = JSON.parse(fs.readFileSync(resolvedArtifact, 'utf8')) as EvolutionCandidateRecord
  if (onDisk.candidateId !== candidate.candidateId) {
    throw new Error('artifact candidateId mismatch')
  }
  const strategy = parseDeliverGateStrategy(onDisk.strategy)
  const strategyDigest = stableJsonDigest(strategy)
  if (strategyDigest !== candidate.strategyDigest) {
    throw new Error('strategy payload digest mismatch (stale or tampered promotion rejected)')
  }
  const fileDigest = sha256File(resolvedArtifact)
  if (onDisk.strategyDigest && onDisk.strategyDigest !== candidate.strategyDigest) {
    throw new Error('recorded strategyDigest mismatch')
  }
  void fileDigest

  const holdout = candidate.scores.find(score => score.split === 'holdout')
  const validation = candidate.scores.find(score => score.split === 'validation')
  const baselineHoldout = input.runReport.baseline.find(score => score.split === 'holdout')
  if (!holdout || holdout.accuracy < (baselineHoldout?.accuracy ?? 0)) {
    throw new Error('holdout regression vs baseline; promotion refused')
  }
  if (!validation || validation.accuracy < 1) {
    throw new Error('validation gate not satisfied; promotion refused')
  }

  fs.mkdirSync(path.dirname(promotedStrategyPath(input.home)), { recursive: true })
  fs.writeFileSync(promotedStrategyPath(input.home), JSON.stringify(strategy, null, 2), 'utf8')
  const record: PromotionRecord = {
    approvedAt: new Date().toISOString(),
    strategyDigest: candidate.strategyDigest,
    artifactPath: resolvedArtifact,
    runId: input.runReport.runId,
    candidateId: candidate.candidateId,
  }
  fs.writeFileSync(promotionRecordPath(input.home), JSON.stringify(record, null, 2), 'utf8')
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
  return { rolledBack: true, previousDigest }
}

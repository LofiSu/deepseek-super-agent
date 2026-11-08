import fs from 'node:fs'
import path from 'node:path'
import { parseDeliverGateStrategy } from './strategy-gate.ts'
import { stableJsonDigest } from './digest.ts'
import type { DeliverGateStrategyV1, PromotionRecord } from './types.ts'
import { PROMOTED_STRATEGY_FILE, promotionRecordPath } from './promotion.ts'
import { resolveInsideDir } from './io.ts'
import { evolutionArchiveRoot } from './archive.ts'

export function loadPromotedStrategy(home: string): DeliverGateStrategyV1 | null {
  const evolutionRoot = path.join(home, 'evolution')
  const recordFile = promotionRecordPath(home)
  const strategyFile = path.join(evolutionRoot, PROMOTED_STRATEGY_FILE)
  if (!fs.existsSync(recordFile)) return null
  if (!fs.existsSync(strategyFile)) return null

  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8')) as PromotionRecord
  resolveInsideDir(evolutionRoot, strategyFile)

  const raw = JSON.parse(fs.readFileSync(strategyFile, 'utf8'))
  const strategy = parseDeliverGateStrategy(raw)
  const strategyDigest = stableJsonDigest(strategy)
  if (strategyDigest !== record.strategyDigest) {
    throw new Error('promoted strategy digest mismatch vs promotion record')
  }

  if (!record.artifactPath || !fs.existsSync(record.artifactPath)) {
    throw new Error('promotion record missing artifact path')
  }

  const archiveRoot = evolutionArchiveRoot(home)
  const resolvedArtifact = resolveInsideDir(archiveRoot, record.artifactPath)
  const artifact = JSON.parse(fs.readFileSync(resolvedArtifact, 'utf8')) as {
    strategyDigest?: string
    artifactDigest?: string
    candidateId?: string
  }
  if (artifact.candidateId !== record.candidateId) {
    throw new Error('promotion artifact candidateId mismatch')
  }
  if (artifact.strategyDigest !== record.strategyDigest) {
    throw new Error('promotion artifact strategy digest mismatch')
  }
  if (!artifact.artifactDigest || artifact.artifactDigest !== record.artifactDigest) {
    throw new Error('promotion artifact content digest mismatch')
  }

  return strategy
}

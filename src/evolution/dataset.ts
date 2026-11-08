import fs from 'node:fs'
import path from 'node:path'
import { sha256File, stableJsonDigest } from './digest.ts'
import type {
  DeliverGateStrategyV1,
  EvolutionEvalCase,
  EvolutionSplitFile,
  EvolutionSplitManifest,
} from './types.ts'
import { DELIVER_GATE_DOMAIN, EVOLUTION_SCHEMA_VERSION } from './types.ts'

export interface LoadedEvolutionDataset {
  root: string
  manifest: EvolutionSplitManifest
  train: EvolutionEvalCase[]
  validation: EvolutionEvalCase[]
  holdout: EvolutionEvalCase[]
  datasetDigest: string
}

function readSplit(root: string, rel: string): EvolutionEvalCase[] {
  const file = path.join(root, rel)
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as EvolutionSplitFile
  if (!Array.isArray(parsed.cases)) throw new Error(`invalid split ${rel}: missing cases[]`)
  return parsed.cases
}

export function loadEvolutionDataset(datasetRoot: string): LoadedEvolutionDataset {
  const manifestPath = path.join(datasetRoot, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as EvolutionSplitManifest
  if (manifest.schemaVersion !== EVOLUTION_SCHEMA_VERSION) {
    throw new Error(`unsupported dataset schemaVersion ${manifest.schemaVersion}`)
  }
  if (manifest.domain !== DELIVER_GATE_DOMAIN) {
    throw new Error(`unsupported dataset domain ${manifest.domain}`)
  }
  const train = readSplit(datasetRoot, manifest.splits.train)
  const validation = readSplit(datasetRoot, manifest.splits.validation)
  const holdout = readSplit(datasetRoot, manifest.splits.holdout)
  const parts = [
    sha256File(manifestPath),
    sha256File(path.join(datasetRoot, manifest.splits.train)),
    sha256File(path.join(datasetRoot, manifest.splits.validation)),
    sha256File(path.join(datasetRoot, manifest.splits.holdout)),
  ]
  const datasetDigest = stableJsonDigest(parts)
  return { root: datasetRoot, manifest, train, validation, holdout, datasetDigest }
}

export function defaultBaselineStrategy(): DeliverGateStrategyV1 {
  return {
    schemaVersion: EVOLUTION_SCHEMA_VERSION,
    domain: DELIVER_GATE_DOMAIN,
    negativePattern:
      "\\b(nothing|no change|unable|could not|cannot|not valuable|wontfix|won't fix)\\b",
    positivePattern:
      "\\b(ready|fixed|fix|reproduced|reproduce|valuable|found|resolved|patch|passing|passed)\\b",
    clauseLocalPositive: true,
  }
}

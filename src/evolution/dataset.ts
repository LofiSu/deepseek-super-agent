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
  /** Sealed split C — never load into search/proposer/memory */
  finaltest: EvolutionEvalCase[]
  datasetDigest: string
  finaltestDigest: string
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
  if (manifest.schemaVersion !== EVOLUTION_SCHEMA_VERSION && manifest.schemaVersion !== 1) {
    throw new Error(`unsupported dataset schemaVersion ${manifest.schemaVersion}`)
  }
  if (manifest.domain !== DELIVER_GATE_DOMAIN) {
    throw new Error(`unsupported dataset domain ${manifest.domain}`)
  }
  const train = readSplit(datasetRoot, manifest.splits.train)
  const validation = readSplit(datasetRoot, manifest.splits.validation)
  const finalRel = manifest.splits.finaltest
  const finaltest = readSplit(datasetRoot, finalRel)
  const parts = [
    sha256File(manifestPath),
    sha256File(path.join(datasetRoot, manifest.splits.train)),
    sha256File(path.join(datasetRoot, manifest.splits.validation)),
    sha256File(path.join(datasetRoot, finalRel)),
  ]
  const datasetDigest = stableJsonDigest(parts)
  const finaltestDigest = sha256File(path.join(datasetRoot, finalRel))
  return { root: datasetRoot, manifest, train, validation, finaltest, datasetDigest, finaltestDigest }
}

/** Search-visible dataset only (no finaltest labels). */
export function loadSearchDataset(datasetRoot: string): Omit<LoadedEvolutionDataset, 'finaltest' | 'finaltestDigest'> & {
  finaltest: never
  finaltestDigest: never
} {
  const full = loadEvolutionDataset(datasetRoot)
  const { finaltest: _omit, finaltestDigest: _o2, ...rest } = full
  return { ...rest, finaltest: undefined as never, finaltestDigest: undefined as never }
}

export function defaultBaselineStrategy(): DeliverGateStrategyV1 {
  return {
    schemaVersion: EVOLUTION_SCHEMA_VERSION,
    domain: DELIVER_GATE_DOMAIN,
    positiveTokens: [
      'ready', 'fixed', 'fix', 'reproduced', 'reproduce', 'valuable', 'found',
      'resolved', 'patch', 'passing', 'passed',
    ],
    negativeTokens: [
      'nothing', 'no change', 'unable', 'could not', 'cannot', 'not valuable', 'wontfix', "won't fix",
    ],
    clauseLocalPositive: true,
  }
}

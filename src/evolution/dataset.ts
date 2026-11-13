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

export interface LoadedSearchDataset {
  root: string
  manifest: EvolutionSplitManifest
  train: EvolutionEvalCase[]
  validation: EvolutionEvalCase[]
  datasetDigest: string
  /** From manifest only — finaltest file not read during search. */
  finaltestDigest: string
}

export interface LoadedEvolutionDataset extends LoadedSearchDataset {
  finaltest: EvolutionEvalCase[]
}

function readManifest(datasetRoot: string): EvolutionSplitManifest {
  const manifestPath = path.join(datasetRoot, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as EvolutionSplitManifest
  if (manifest.schemaVersion !== EVOLUTION_SCHEMA_VERSION && manifest.schemaVersion !== 1) {
    throw new Error(`unsupported dataset schemaVersion ${manifest.schemaVersion}`)
  }
  if (manifest.domain !== DELIVER_GATE_DOMAIN) {
    throw new Error(`unsupported dataset domain ${manifest.domain}`)
  }
  if (!manifest.splitDigests?.finaltest) {
    throw new Error('manifest missing splitDigests.finaltest')
  }
  return manifest
}

function readSplit(root: string, rel: string): EvolutionEvalCase[] {
  const file = path.join(root, rel)
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as EvolutionSplitFile
  if (!Array.isArray(parsed.cases)) throw new Error(`invalid split ${rel}: missing cases[]`)
  return parsed.cases
}

/** Resolve a split path under the dataset root, following symlinks when it exists. */
function canonicalSplitPath(datasetRoot: string, rel: string): string {
  const absolute = path.resolve(datasetRoot, rel)
  try {
    return fs.realpathSync(absolute)
  } catch {
    return absolute
  }
}

/** Same on-disk file? Compares dev+inode, which also catches hard links. */
function isSameExistingFile(a: string, b: string): boolean {
  try {
    const statA = fs.statSync(a)
    const statB = fs.statSync(b)
    return statA.dev === statB.dev && statA.ino === statB.ino
  } catch {
    return false
  }
}

/**
 * Search-phase isolation: train and validation must not identify the same file
 * as finaltest (same name, `./` alias, symlink target, or hard link). Runs
 * before any search split is read so an aliased finaltest is never opened
 * unclaimed.
 */
function assertSearchSplitsDoNotAliasFinaltest(
  datasetRoot: string,
  manifest: EvolutionSplitManifest,
): void {
  const finaltestAbsolute = path.resolve(datasetRoot, manifest.splits.finaltest)
  const finaltest = canonicalSplitPath(datasetRoot, manifest.splits.finaltest)
  for (const split of ['train', 'validation'] as const) {
    const splitAbsolute = path.resolve(datasetRoot, manifest.splits[split])
    if (
      canonicalSplitPath(datasetRoot, manifest.splits[split]) === finaltest ||
      isSameExistingFile(splitAbsolute, finaltestAbsolute)
    ) {
      throw new Error(`search split aliases the finaltest file: ${split}`)
    }
  }
}

function datasetDigestFromManifest(datasetRoot: string, manifest: EvolutionSplitManifest): string {
  const manifestPath = path.join(datasetRoot, 'manifest.json')
  const parts = [
    sha256File(manifestPath),
    sha256File(path.join(datasetRoot, manifest.splits.train)),
    sha256File(path.join(datasetRoot, manifest.splits.validation)),
    manifest.splitDigests.finaltest,
  ]
  return stableJsonDigest(parts)
}

/** Search phase: never reads finaltest.json. */
export function loadSearchDatasetOnly(datasetRoot: string): LoadedSearchDataset {
  const manifest = readManifest(datasetRoot)
  assertSearchSplitsDoNotAliasFinaltest(datasetRoot, manifest)
  const train = readSplit(datasetRoot, manifest.splits.train)
  const validation = readSplit(datasetRoot, manifest.splits.validation)
  const datasetDigest = datasetDigestFromManifest(datasetRoot, manifest)
  return {
    root: datasetRoot,
    manifest,
    train,
    validation,
    datasetDigest,
    finaltestDigest: manifest.splitDigests.finaltest,
  }
}

/** Finalization only: loads sealed split C after claim. */
export function loadFinaltestSplit(datasetRoot: string): EvolutionEvalCase[] {
  const manifest = readManifest(datasetRoot)
  const file = path.join(datasetRoot, manifest.splits.finaltest)
  const digest = sha256File(file)
  if (digest !== manifest.splitDigests.finaltest) {
    throw new Error('finaltest file digest mismatch vs manifest')
  }
  return readSplit(datasetRoot, manifest.splits.finaltest)
}

export function loadEvolutionDataset(datasetRoot: string): LoadedEvolutionDataset {
  const search = loadSearchDatasetOnly(datasetRoot)
  const finaltest = loadFinaltestSplit(datasetRoot)
  return { ...search, finaltest }
}

/** @deprecated use loadSearchDatasetOnly */
export function loadSearchDataset(datasetRoot: string) {
  return loadSearchDatasetOnly(datasetRoot)
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

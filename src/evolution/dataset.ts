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
  /** Declared in the manifest; the search phase never parses finaltest cases. */
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

function readSplit(file: string, rel: string): EvolutionEvalCase[] {
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

type SplitName = 'train' | 'validation' | 'finaltest'

interface ConfinedSplits {
  train: string
  validation: string
  finaltest: string
}

/**
 * Search-phase isolation: every split path in the manifest must stay inside the
 * real dataset root. Resolves with `realpathSync` when the target exists, so
 * `..` escapes, absolute paths outside the root, and symlinks pointing outside
 * the root are all rejected before any split file is opened. A missing train or
 * validation path is resolved lexically and left to fail at the read site; a
 * missing finaltest path fails closed during search (see the content check).
 */
function resolveSplitInsideRoot(root: string, rel: string, split: SplitName): string {
  const absolute = path.resolve(root, rel)
  let resolved: string
  try {
    resolved = fs.realpathSync(absolute)
  } catch {
    resolved = absolute
  }
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(
      split === 'finaltest'
        ? `finaltest split escapes the dataset root: ${split}`
        : `search split escapes the dataset root: ${split}`,
    )
  }
  return resolved
}

function confineSplits(root: string, manifest: EvolutionSplitManifest): ConfinedSplits {
  return {
    train: resolveSplitInsideRoot(root, manifest.splits.train, 'train'),
    validation: resolveSplitInsideRoot(root, manifest.splits.validation, 'validation'),
    finaltest: resolveSplitInsideRoot(root, manifest.splits.finaltest, 'finaltest'),
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

/** True only for an existing regular file. */
function isExistingRegularFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * Normalize a declared SHA-256 so search and finalize agree: `sha256File` emits
 * lowercase hex, so a 64-hex commitment compares after lowercasing. A dummy or
 * otherwise non-hex value returns `null` and is compared exactly as declared.
 */
function declaredSha256Hex(declared: string): string | null {
  const normalized = declared.toLowerCase()
  return SHA256_HEX.test(normalized) ? normalized : null
}

/**
 * Search-phase isolation: a search split must not be a byte-identical copy of
 * finaltest. Distinct paths and inodes still leak held-out cases if the bytes
 * match, so hash the search splits. A declared SHA-256 is a commitment, so hash
 * the actual finaltest file and reject a manifest whose declared digest does not
 * match it before comparing search splits. When the manifest carries a dummy
 * digest, hash finaltest's bytes for the identity check only. Hashing is a
 * checksum read: finaltest cases are never parsed or returned during search.
 * Search fails closed when the confined finaltest path is missing or not a
 * regular file: otherwise hiding the holdout would disable the identity check
 * while a byte-identical train/validation copy still leaks it.
 */
function assertSearchSplitsDoNotCopyFinaltestContent(
  datasetRoot: string,
  manifest: EvolutionSplitManifest,
): void {
  const declaredHex = declaredSha256Hex(manifest.splitDigests.finaltest)
  const finaltest = canonicalSplitPath(datasetRoot, manifest.splits.finaltest)
  if (!isExistingRegularFile(finaltest)) {
    throw new Error('finaltest file missing during search')
  }
  const actualFinaltestDigest = sha256File(finaltest)
  if (declaredHex !== null && actualFinaltestDigest !== declaredHex) {
    throw new Error('finaltest file digest mismatch vs manifest')
  }
  const finaltestDigest = declaredHex ?? actualFinaltestDigest
  for (const split of ['train', 'validation'] as const) {
    const splitFile = canonicalSplitPath(datasetRoot, manifest.splits[split])
    if (!isExistingRegularFile(splitFile)) continue
    if (sha256File(splitFile) === finaltestDigest) {
      throw new Error(
        `search split aliases the finaltest file: ${split} (byte-identical contents)`,
      )
    }
  }
}

/**
 * Search-phase isolation: a declared train/validation SHA-256 is a commitment
 * for the search split actually read. Only a 64-hex value is a commitment;
 * dummy/empty values keep the pre-existing behavior and are not compared here.
 * A declared 64-hex digest makes the corresponding split mandatory, so a
 * missing file cannot silently skip the check and load unverified bytes.
 */
function assertDeclaredSearchSplitDigests(
  manifest: EvolutionSplitManifest,
  splits: ConfinedSplits,
): void {
  for (const split of ['train', 'validation'] as const) {
    const declaredHex = declaredSha256Hex(manifest.splitDigests[split] ?? '')
    if (declaredHex === null) continue
    if (!isExistingRegularFile(splits[split])) {
      throw new Error(`${split} file missing during search`)
    }
    if (sha256File(splits[split]) !== declaredHex) {
      throw new Error(`${split} file digest mismatch vs manifest`)
    }
  }
}

/**
 * Search-phase isolation: train and validation must not identify the same file
 * as finaltest (same name, `./` alias, symlink target, or hard link). Runs
 * before any search split is read so an aliased finaltest is never opened
 * unclaimed. After those path checks, a byte-identical copy (distinct path and
 * inode) is rejected too.
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
  assertSearchSplitsDoNotCopyFinaltestContent(datasetRoot, manifest)
}

/**
 * Search-phase isolation: train and validation must be independent splits, so
 * an identity between them would score the validation gate on train cases.
 * Reject the same confined file (same path, `./` alias, symlink target, or hard
 * link) before either split is read, then reject a byte-identical copy that
 * keeps a distinct path and inode. Hashing is a checksum read, not a parse.
 */
function assertSearchSplitsAreIndependent(splits: ConfinedSplits): void {
  if (
    splits.train === splits.validation ||
    isSameExistingFile(splits.train, splits.validation)
  ) {
    throw new Error('search splits alias each other: train and validation')
  }
  if (
    isExistingRegularFile(splits.train) &&
    isExistingRegularFile(splits.validation) &&
    sha256File(splits.train) === sha256File(splits.validation)
  ) {
    throw new Error(
      'search splits alias each other: train and validation (byte-identical contents)',
    )
  }
}

function datasetDigestFromManifest(
  root: string,
  manifest: EvolutionSplitManifest,
  splits: ConfinedSplits,
): string {
  const manifestPath = path.join(root, 'manifest.json')
  const parts = [
    sha256File(manifestPath),
    sha256File(splits.train),
    sha256File(splits.validation),
    manifest.splitDigests.finaltest,
  ]
  return stableJsonDigest(parts)
}

/**
 * Search phase: parses only train/validation. The finaltest file may be
 * hashed to verify its manifest commitment, but its cases are never parsed.
 */
export function loadSearchDatasetOnly(datasetRoot: string): LoadedSearchDataset {
  const root = fs.realpathSync(path.resolve(datasetRoot))
  const manifest = readManifest(root)
  const splits = confineSplits(root, manifest)
  assertSearchSplitsDoNotAliasFinaltest(root, manifest)
  assertSearchSplitsAreIndependent(splits)
  assertDeclaredSearchSplitDigests(manifest, splits)
  const train = readSplit(splits.train, manifest.splits.train)
  const validation = readSplit(splits.validation, manifest.splits.validation)
  const datasetDigest = datasetDigestFromManifest(root, manifest, splits)
  return {
    root,
    manifest,
    train,
    validation,
    datasetDigest,
    finaltestDigest: manifest.splitDigests.finaltest,
  }
}

/** Finalization only: loads sealed split C after claim. */
export function loadFinaltestSplit(datasetRoot: string): EvolutionEvalCase[] {
  const root = fs.realpathSync(path.resolve(datasetRoot))
  const manifest = readManifest(root)
  const file = resolveSplitInsideRoot(root, manifest.splits.finaltest, 'finaltest')
  const digest = sha256File(file)
  // Same normalization as search: uppercase/mixed-case hex commitments match the
  // lowercase file hash; a dummy declared value must match it exactly.
  const expected = declaredSha256Hex(manifest.splitDigests.finaltest) ?? manifest.splitDigests.finaltest
  if (digest !== expected) {
    throw new Error('finaltest file digest mismatch vs manifest')
  }
  return readSplit(file, manifest.splits.finaltest)
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

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256File } from '../src/evolution/digest.ts'
import { loadEvolutionDataset, loadFinaltestSplit, loadSearchDatasetOnly } from '../src/evolution/dataset.ts'

const FIXTURE_DATASET_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'evolution',
)

const CANARY = 'SECRET_HOLDOUT_TOKEN'
const OUTSIDE_CANARY = 'SECRET_OUTSIDE_TOKEN'

interface WrittenCase {
  id: string
  text: string
  /** Arbitrary value so invalid labels (wrong case, null, "") can be written. */
  expected?: unknown
  /** Omit `expected` entirely from the row. */
  omitExpected?: boolean
  /**
   * Arbitrary value so invalid speculative flags (string, null, 0, 1) can be
   * written. When omitted, an honest boolean `true` is written.
   */
  speculative?: unknown
  /** Omit `speculative` entirely from the row. */
  omitSpeculative?: boolean
}

function writeSplitCases(file: string, cases: WrittenCase[]): void {
  fs.writeFileSync(
    file,
    JSON.stringify({
      cases: cases.map(({ id, text, expected, omitExpected, speculative, omitSpeculative }) => {
        const row: Record<string, unknown> = {
          id,
          report: { kind: 'ready', text },
        }
        if (!omitSpeculative) row.speculative = speculative === undefined ? true : speculative
        if (!omitExpected) row.expected = expected === undefined ? 'deliver' : expected
        return row
      }),
    }),
  )
}

function writeSplit(file: string, id: string, text: string): void {
  writeSplitCases(file, [{ id, text }])
}

interface TempDataset {
  root: string
  cleanup: () => void
}

function makeDataset(
  splits: { train: string; validation: string },
  finaltestDigest = 'unused-by-search-phase',
): TempDataset {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-split-alias-'))
  writeSplit(path.join(root, 'train.json'), 't1', 'train case does not leak')
  writeSplit(path.join(root, 'validation.json'), 'v1', 'validation case does not leak')
  writeSplit(path.join(root, 'finaltest.json'), 'f1', `held-out case ${CANARY}`)
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 2,
      domain: 'deliver-gate-v1',
      splits: {
        train: splits.train,
        validation: splits.validation,
        finaltest: 'finaltest.json',
      },
      splitDigests: { train: '', validation: '', finaltest: finaltestDigest },
      seed: 20260308,
    }),
  )
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

/** Rewrite only the declared finaltest digest, simulating a lying manifest. */
function setDeclaredFinaltestDigest(root: string, digest: string): void {
  const manifestPath = path.join(root, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    splitDigests: { finaltest: string }
  }
  manifest.splitDigests.finaltest = digest
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
}

/** Rewrite only the declared train or validation digest, simulating a lying manifest. */
function setDeclaredSearchDigest(
  root: string,
  split: 'train' | 'validation',
  digest: string,
): void {
  const manifestPath = path.join(root, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    splitDigests: { train?: string; validation?: string }
  }
  manifest.splitDigests[split] = digest
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
}

function setDeclaredSearchDigests(root: string, train: string, validation: string): void {
  setDeclaredSearchDigest(root, 'train', train)
  setDeclaredSearchDigest(root, 'validation', validation)
}

function toMixedCase(hex: string): string {
  return hex
    .split('')
    .map((ch, index) => (index % 2 === 0 ? ch.toUpperCase() : ch))
    .join('')
}

/**
 * A valid-looking SHA-256 that belongs to a different file of the same dataset,
 * while `finaltest.json` still holds the real canary holdout.
 */
function digestOfSiblingFile(root: string, name: string): string {
  return sha256File(path.join(root, name))
}

function captureReads(): { reads: string[]; restore: () => void } {
  const realRead = fs.readFileSync.bind(fs)
  const original = fs.readFileSync
  const reads: string[] = []
  ;(fs as { readFileSync: typeof fs.readFileSync }).readFileSync = ((
    p: fs.PathOrFileDescriptor,
    options?: Parameters<typeof fs.readFileSync>[1],
  ) => {
    reads.push(String(p))
    return options === undefined ? realRead(p) : realRead(p, options)
  }) as typeof fs.readFileSync
  return {
    reads,
    restore: () => {
      fs.readFileSync = original
    },
  }
}

/**
 * Dataset root plus a sibling `outside/` directory holding a canary split, so
 * a manifest can point a split out of the root via `..` or a symlink.
 */
function makeEscapingDataset(splits: { train: string; validation: string }): TempDataset & {
  outsideFile: string
} {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-split-escape-'))
  const root = path.join(parent, 'dataset')
  const outside = path.join(parent, 'outside')
  fs.mkdirSync(root)
  fs.mkdirSync(outside)
  writeSplit(path.join(root, 'train.json'), 't1', 'train case does not leak')
  writeSplit(path.join(root, 'validation.json'), 'v1', 'validation case does not leak')
  writeSplit(path.join(root, 'finaltest.json'), 'f1', `held-out case ${CANARY}`)
  const outsideFile = path.join(outside, 'leaked.json')
  writeSplit(outsideFile, 'x1', `escaped case ${OUTSIDE_CANARY}`)
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 2,
      domain: 'deliver-gate-v1',
      splits: {
        train: splits.train,
        validation: splits.validation,
        finaltest: 'finaltest.json',
      },
      splitDigests: { train: '', validation: '', finaltest: 'unused-by-search-phase' },
      seed: 20260308,
    }),
  )
  return { root, outsideFile, cleanup: () => fs.rmSync(parent, { recursive: true, force: true }) }
}

/**
 * Replace a split with a byte-identical copy of finaltest: a distinct path and
 * inode, so only a content check can catch it. The copy carries the canary —
 * exactly the held-out material that must never reach search.
 */
function copyFinaltestOver(root: string, split: 'train' | 'validation'): void {
  const target = path.join(root, `${split}.json`)
  fs.copyFileSync(path.join(root, 'finaltest.json'), target)
  const finaltestStat = fs.statSync(path.join(root, 'finaltest.json'))
  const copyStat = fs.statSync(target)
  expect(copyStat.dev === finaltestStat.dev && copyStat.ino === finaltestStat.ino).toBe(false)
  expect(fs.readFileSync(target, 'utf8')).toContain(CANARY)
}

/** Rejected loads must stop after the manifest — no split file is opened. */
function expectRejectedBeforeSplitRead(loader: () => unknown): void {
  const { reads, restore } = captureReads()
  try {
    expect(loader).toThrow(/search split aliases the finaltest file/)
  } finally {
    restore()
  }
  expect(reads.map(p => path.basename(String(p)))).toEqual(['manifest.json'])
}

/** An escaped split is rejected after the manifest and before the outside file is opened. */
function expectRootEscapeRejected(loader: () => unknown, escapedFile: string): void {
  const { reads, restore } = captureReads()
  try {
    expect(loader).toThrow(/escapes the dataset root/)
  } finally {
    restore()
  }
  const readPaths = reads.map(p => path.resolve(String(p)))
  expect(readPaths).not.toContain(path.resolve(escapedFile))
  expect(reads.map(p => path.basename(String(p)))).toEqual(['manifest.json'])
}

describe('regression: search splits cannot alias finaltest (PR168)', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  function dataset(splits: { train: string; validation: string }): TempDataset {
    const temp = makeDataset(splits)
    cleanups.push(temp.cleanup)
    return temp
  }

  function escapingDataset(splits: { train: string; validation: string }) {
    const temp = makeEscapingDataset(splits)
    cleanups.push(temp.cleanup)
    return temp
  }

  it('rejects a train split with the same relative finaltest name', () => {
    const { root } = dataset({ train: 'finaltest.json', validation: 'validation.json' })
    expectRejectedBeforeSplitRead(() => loadSearchDatasetOnly(root))
  })

  it('rejects a train split using a dot-slash finaltest alias', () => {
    const { root } = dataset({ train: './finaltest.json', validation: 'validation.json' })
    expectRejectedBeforeSplitRead(() => loadSearchDatasetOnly(root))
  })

  it('rejects a train split that is a symlink to the finaltest file', () => {
    const { root } = dataset({ train: 'train-alias.json', validation: 'validation.json' })
    fs.symlinkSync(path.join(root, 'finaltest.json'), path.join(root, 'train-alias.json'))
    expectRejectedBeforeSplitRead(() => loadSearchDatasetOnly(root))
  })

  it('rejects a validation split that aliases the finaltest file', () => {
    const { root } = dataset({ train: 'train.json', validation: './finaltest.json' })
    expectRejectedBeforeSplitRead(() => loadSearchDatasetOnly(root))
  })

  it('rejects a train split that is a hard link to the finaltest file', () => {
    const { root } = dataset({ train: 'train.json', validation: 'validation.json' })
    fs.rmSync(path.join(root, 'train.json'))
    fs.linkSync(path.join(root, 'finaltest.json'), path.join(root, 'train.json'))
    expectRejectedBeforeSplitRead(() => loadSearchDatasetOnly(root))
  })

  it('rejects a validation split that is a hard link to the finaltest file', () => {
    const { root } = dataset({ train: 'train.json', validation: 'validation.json' })
    fs.rmSync(path.join(root, 'validation.json'))
    fs.linkSync(path.join(root, 'finaltest.json'), path.join(root, 'validation.json'))
    expectRejectedBeforeSplitRead(() => loadSearchDatasetOnly(root))
  })

  it('rejects a train split that is a byte-identical copy of finaltest', () => {
    const { root } = dataset({ train: 'train.json', validation: 'validation.json' })
    copyFinaltestOver(root, 'train')
    expect(() => loadSearchDatasetOnly(root)).toThrow(
      /search split aliases the finaltest file: train/,
    )
  })

  it('rejects a validation split that is a byte-identical copy of finaltest', () => {
    const { root } = dataset({ train: 'train.json', validation: 'validation.json' })
    copyFinaltestOver(root, 'validation')
    expect(() => loadSearchDatasetOnly(root)).toThrow(
      /search split aliases the finaltest file: validation/,
    )
  })

  it('rejects a byte-identical finaltest copy through loadEvolutionDataset too', () => {
    const { root } = dataset({ train: 'train.json', validation: 'validation.json' })
    copyFinaltestOver(root, 'train')
    expect(() => loadEvolutionDataset(root)).toThrow(
      /search split aliases the finaltest file: train/,
    )
  })

  it('rejects the alias through loadEvolutionDataset too', () => {
    const { root } = dataset({ train: 'finaltest.json', validation: 'validation.json' })
    expectRejectedBeforeSplitRead(() => loadEvolutionDataset(root))
  })

  it('rejects a train split that escapes the dataset root via ..', () => {
    const { root, outsideFile } = escapingDataset({
      train: '../outside/leaked.json',
      validation: 'validation.json',
    })
    expectRootEscapeRejected(() => loadSearchDatasetOnly(root), outsideFile)
  })

  it('rejects a validation split that escapes the dataset root via ..', () => {
    const { root, outsideFile } = escapingDataset({
      train: 'train.json',
      validation: '../outside/leaked.json',
    })
    expectRootEscapeRejected(() => loadSearchDatasetOnly(root), outsideFile)
  })

  it('rejects an in-root split symlink whose target is outside the dataset root', () => {
    const { root, outsideFile } = escapingDataset({
      train: 'train-link.json',
      validation: 'validation.json',
    })
    fs.symlinkSync(outsideFile, path.join(root, 'train-link.json'))
    expectRootEscapeRejected(() => loadSearchDatasetOnly(root), outsideFile)
  })

  it('rejects a lying valid finaltest digest even when train copies the holdout', () => {
    const { root } = dataset({ train: 'train.json', validation: 'validation.json' })
    writeSplit(path.join(root, 'dummy-finaltest.json'), 'easy', 'dummy holdout')
    // Valid SHA-256, but of another file: the manifest lies about the holdout.
    setDeclaredFinaltestDigest(root, digestOfSiblingFile(root, 'dummy-finaltest.json'))
    copyFinaltestOver(root, 'train')
    expect(() => loadSearchDatasetOnly(root)).toThrow(/finaltest file digest mismatch/)
    expect(() => loadEvolutionDataset(root)).toThrow(/finaltest file digest mismatch/)
  })

  it('rejects a valid-looking wrong finaltest digest without any content copy', () => {
    const { root } = dataset({ train: 'train.json', validation: 'validation.json' })
    setDeclaredFinaltestDigest(root, digestOfSiblingFile(root, 'validation.json'))
    expect(() => loadSearchDatasetOnly(root)).toThrow(/finaltest file digest mismatch/)
  })

  it('rejects a lying finaltest digest through loadEvolutionDataset too', () => {
    const { root } = dataset({ train: 'train.json', validation: 'validation.json' })
    setDeclaredFinaltestDigest(root, digestOfSiblingFile(root, 'validation.json'))
    expect(() => loadEvolutionDataset(root)).toThrow(/finaltest file digest mismatch/)
  })

  it('still loads an honest dataset whose declared digest matches finaltest', () => {
    const { root } = dataset({ train: 'train.json', validation: 'validation.json' })
    setDeclaredFinaltestDigest(root, digestOfSiblingFile(root, 'finaltest.json'))
    const data = loadSearchDatasetOnly(root)
    expect(data.train.map(c => c.id)).toEqual(['t1'])
    expect(data.validation.map(c => c.id)).toEqual(['v1'])
    const searchText = [...data.train, ...data.validation].map(c => c.report.text).join('\n')
    expect(searchText).not.toContain(CANARY)
  })

  it('still loads an honest dataset with three distinct files', () => {
    const { root } = escapingDataset({ train: 'train.json', validation: 'validation.json' })
    const data = loadSearchDatasetOnly(root)
    expect(data.train.map(c => c.id)).toEqual(['t1'])
    expect(data.validation.map(c => c.id)).toEqual(['v1'])
    const searchText = [...data.train, ...data.validation].map(c => c.report.text).join('\n')
    expect(searchText).not.toContain(CANARY)
    expect(searchText).not.toContain(OUTSIDE_CANARY)
  })

  it('still loads an honest in-root split from a subdirectory', () => {
    const { root } = dataset({ train: 'splits/train.json', validation: 'validation.json' })
    fs.mkdirSync(path.join(root, 'splits'))
    writeSplit(path.join(root, 'splits', 'train.json'), 't2', 'nested train case does not leak')
    const data = loadSearchDatasetOnly(root)
    expect(data.train.map(c => c.id)).toEqual(['t2'])
    expect(data.validation.map(c => c.id)).toEqual(['v1'])
  })

  it('rejects search when an honest-digest holdout is hidden behind a byte-identical train copy', () => {
    const { root } = dataset({ train: 'train.json', validation: 'validation.json' })
    setDeclaredFinaltestDigest(root, digestOfSiblingFile(root, 'finaltest.json'))
    copyFinaltestOver(root, 'train')
    const finaltest = path.join(root, 'finaltest.json')
    const hidden = path.join(root, 'finaltest.json.hidden')
    fs.renameSync(finaltest, hidden)

    expect(() => loadSearchDatasetOnly(root)).toThrow(/finaltest file missing during search/)

    // Restoring the holdout and an honest train leaves a loadable dataset for finalize.
    fs.renameSync(hidden, finaltest)
    writeSplit(path.join(root, 'train.json'), 't1', 'train case does not leak')
    expect(loadFinaltestSplit(root).map(c => c.id)).toEqual(['f1'])
  })

  it('rejects search when a dummy-digest holdout is hidden behind a byte-identical train copy', () => {
    const { root } = dataset({ train: 'train.json', validation: 'validation.json' })
    copyFinaltestOver(root, 'train')
    const hidden = path.join(root, 'finaltest.json.hidden')
    fs.renameSync(path.join(root, 'finaltest.json'), hidden)

    expect(() => loadSearchDatasetOnly(root)).toThrow(/finaltest file missing during search/)
  })

  it('rejects search when finaltest is missing even without any content copy', () => {
    const { root } = dataset({ train: 'train.json', validation: 'validation.json' })
    setDeclaredFinaltestDigest(root, digestOfSiblingFile(root, 'finaltest.json'))
    fs.rmSync(path.join(root, 'finaltest.json'))

    const { reads, restore } = captureReads()
    try {
      expect(() => loadSearchDatasetOnly(root)).toThrow(/finaltest file missing during search/)
    } finally {
      restore()
    }
    // The missing holdout is rejected at search, not deferred to finalize.
    expect(reads.map(p => path.basename(String(p)))).toEqual(['manifest.json'])
  })
})

describe('regression: finaltest digest hex normalization (PR168)', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  function dataset(): TempDataset {
    const temp = makeDataset({ train: 'train.json', validation: 'validation.json' })
    cleanups.push(temp.cleanup)
    return temp
  }

  it('loads an uppercase honest digest at search and finalize', () => {
    const { root } = dataset()
    const actual = digestOfSiblingFile(root, 'finaltest.json')
    setDeclaredFinaltestDigest(root, actual.toUpperCase())

    const search = loadSearchDatasetOnly(root)
    expect('finaltest' in search).toBe(false)
    expect(search.finaltestDigest).toBe(actual.toUpperCase())
    const searchText = [...search.train, ...search.validation].map(c => c.report.text).join('\n')
    expect(searchText).not.toContain(CANARY)

    expect(loadFinaltestSplit(root).map(c => c.id)).toEqual(['f1'])
    expect(loadEvolutionDataset(root).finaltest.map(c => c.id)).toEqual(['f1'])
  })

  it('loads a mixed-case honest digest at search and finalize', () => {
    const { root } = dataset()
    const actual = digestOfSiblingFile(root, 'finaltest.json')
    const mixed = actual
      .split('')
      .map((ch, index) => (index % 2 === 0 ? ch.toUpperCase() : ch))
      .join('')
    expect(mixed).not.toBe(actual)
    expect(mixed.toLowerCase()).toBe(actual)
    setDeclaredFinaltestDigest(root, mixed)

    expect(loadSearchDatasetOnly(root).train.map(c => c.id)).toEqual(['t1'])
    expect(loadFinaltestSplit(root).map(c => c.id)).toEqual(['f1'])
    expect(loadEvolutionDataset(root).finaltest.map(c => c.id)).toEqual(['f1'])
  })

  it('still loads the committed lowercase-digest fixture at search and finalize', () => {
    const search = loadSearchDatasetOnly(FIXTURE_DATASET_ROOT)
    expect('finaltest' in search).toBe(false)
    expect(search.train.length).toBeGreaterThan(0)
    expect(loadFinaltestSplit(FIXTURE_DATASET_ROOT).map(c => c.id)).toEqual([
      'ho-001',
      'ho-002',
      'ho-003',
      'ho-004',
    ])
    expect(loadEvolutionDataset(FIXTURE_DATASET_ROOT).finaltest.map(c => c.id)).toEqual([
      'ho-001',
      'ho-002',
      'ho-003',
      'ho-004',
    ])
  })

  it('still rejects a dummy declared digest at finalize while search loads', () => {
    const { root } = dataset()
    expect(loadSearchDatasetOnly(root).train.map(c => c.id)).toEqual(['t1'])
    expect(() => loadFinaltestSplit(root)).toThrow(/finaltest file digest mismatch vs manifest/)
    expect(() => loadEvolutionDataset(root)).toThrow(/finaltest file digest mismatch vs manifest/)
  })

  it('rejects the uppercase form of a different valid digest at search', () => {
    const { root } = dataset()
    setDeclaredFinaltestDigest(root, digestOfSiblingFile(root, 'validation.json').toUpperCase())
    expect(() => loadSearchDatasetOnly(root)).toThrow(/finaltest file digest mismatch/)
    expect(() => loadEvolutionDataset(root)).toThrow(/finaltest file digest mismatch/)
  })
})

describe('regression: train and validation are independent search splits (PR168)', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  function dataset(
    splits: { train: string; validation: string } = {
      train: 'train.json',
      validation: 'validation.json',
    },
  ): TempDataset {
    const temp = makeDataset(splits)
    cleanups.push(temp.cleanup)
    return temp
  }

  function searchText(data: {
    train: Array<{ report: { text: string } }>
    validation: Array<{ report: { text: string } }>
  }): string {
    return [...data.train, ...data.validation].map(c => c.report.text).join('\n')
  }

  it('rejects validation declared as the same file as train', () => {
    const { root } = dataset({ train: 'train.json', validation: 'train.json' })
    // Rejection happens before any split is parsed, so no search cases return.
    expect(() => loadSearchDatasetOnly(root)).toThrow(
      /^search splits alias each other: train and validation$/,
    )
    expect(() => loadEvolutionDataset(root)).toThrow(
      /^search splits alias each other: train and validation$/,
    )
  })

  it('rejects a dot-slash alias between train and validation', () => {
    const { root } = dataset({ train: 'train.json', validation: './train.json' })
    expect(() => loadSearchDatasetOnly(root)).toThrow(
      /^search splits alias each other: train and validation$/,
    )
    expect(() => loadEvolutionDataset(root)).toThrow(
      /^search splits alias each other: train and validation$/,
    )
  })

  it('rejects validation as a symlink to train', () => {
    const { root } = dataset()
    fs.rmSync(path.join(root, 'validation.json'))
    fs.symlinkSync(path.join(root, 'train.json'), path.join(root, 'validation.json'))

    expect(() => loadSearchDatasetOnly(root)).toThrow(
      /^search splits alias each other: train and validation$/,
    )
    expect(() => loadEvolutionDataset(root)).toThrow(
      /^search splits alias each other: train and validation$/,
    )
  })

  it('rejects validation as a hard link to train', () => {
    const { root } = dataset()
    fs.rmSync(path.join(root, 'validation.json'))
    fs.linkSync(path.join(root, 'train.json'), path.join(root, 'validation.json'))

    expect(() => loadSearchDatasetOnly(root)).toThrow(
      /^search splits alias each other: train and validation$/,
    )
    expect(() => loadEvolutionDataset(root)).toThrow(
      /^search splits alias each other: train and validation$/,
    )
  })

  it('rejects validation as a byte-identical copy of train with a distinct inode', () => {
    const { root } = dataset()
    const train = path.join(root, 'train.json')
    const validation = path.join(root, 'validation.json')
    fs.copyFileSync(train, validation)
    const trainStat = fs.statSync(train)
    const validationStat = fs.statSync(validation)
    expect(
      validationStat.dev === trainStat.dev && validationStat.ino === trainStat.ino,
    ).toBe(false)
    expect(fs.readFileSync(validation, 'utf8')).toBe(fs.readFileSync(train, 'utf8'))

    expect(() => loadSearchDatasetOnly(root)).toThrow(
      /^search splits alias each other: train and validation \(byte-identical contents\)$/,
    )
    expect(() => loadEvolutionDataset(root)).toThrow(
      /^search splits alias each other: train and validation \(byte-identical contents\)$/,
    )
  })

  it('still loads honest distinct train and validation at search and finalize', () => {
    const { root } = dataset()
    setDeclaredFinaltestDigest(root, digestOfSiblingFile(root, 'finaltest.json'))

    const search = loadSearchDatasetOnly(root)
    expect('finaltest' in search).toBe(false)
    expect(search.train.map(c => c.id)).toEqual(['t1'])
    expect(search.validation.map(c => c.id)).toEqual(['v1'])
    expect(searchText(search)).not.toContain(CANARY)

    expect(loadEvolutionDataset(root).finaltest.map(c => c.id)).toEqual(['f1'])
  })

  it('still loads the committed fixture at search and finalize', () => {
    const search = loadSearchDatasetOnly(FIXTURE_DATASET_ROOT)
    expect('finaltest' in search).toBe(false)
    expect(search.train).toHaveLength(7)
    expect(search.validation).toHaveLength(4)
    expect(searchText(search)).not.toContain('ho-001')

    expect(loadEvolutionDataset(FIXTURE_DATASET_ROOT).finaltest.map(c => c.id)).toEqual([
      'ho-001',
      'ho-002',
      'ho-003',
      'ho-004',
    ])
  })
})

describe('regression: declared train/validation digests are verified during search (PR168)', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  function dataset(): TempDataset {
    const temp = makeDataset({ train: 'train.json', validation: 'validation.json' })
    cleanups.push(temp.cleanup)
    return temp
  }

  /** Honest finaltest commitment so finalize paths stay realistic. */
  function setHonestFinaltestDigest(root: string): void {
    setDeclaredFinaltestDigest(root, digestOfSiblingFile(root, 'finaltest.json'))
  }

  function searchText(data: { train: Array<{ report: { text: string } }>; validation: Array<{ report: { text: string } }> }): string {
    return [...data.train, ...data.validation].map(c => c.report.text).join('\n')
  }

  it('loads honest lowercase train and validation digests at search and finalize', () => {
    const { root } = dataset()
    setDeclaredSearchDigests(
      root,
      digestOfSiblingFile(root, 'train.json'),
      digestOfSiblingFile(root, 'validation.json'),
    )
    setHonestFinaltestDigest(root)

    const search = loadSearchDatasetOnly(root)
    expect('finaltest' in search).toBe(false)
    expect(search.train.map(c => c.id)).toEqual(['t1'])
    expect(search.validation.map(c => c.id)).toEqual(['v1'])
    expect(searchText(search)).not.toContain(CANARY)

    expect(loadFinaltestSplit(root).map(c => c.id)).toEqual(['f1'])
    expect(loadEvolutionDataset(root).finaltest.map(c => c.id)).toEqual(['f1'])
  })

  it('loads uppercase honest train and validation digests at search and finalize', () => {
    const { root } = dataset()
    setDeclaredSearchDigests(
      root,
      digestOfSiblingFile(root, 'train.json').toUpperCase(),
      digestOfSiblingFile(root, 'validation.json').toUpperCase(),
    )
    setDeclaredFinaltestDigest(root, digestOfSiblingFile(root, 'finaltest.json').toUpperCase())

    const search = loadSearchDatasetOnly(root)
    expect('finaltest' in search).toBe(false)
    expect(search.train.map(c => c.id)).toEqual(['t1'])
    expect(search.validation.map(c => c.id)).toEqual(['v1'])
    expect(searchText(search)).not.toContain(CANARY)

    expect(loadFinaltestSplit(root).map(c => c.id)).toEqual(['f1'])
    expect(loadEvolutionDataset(root).finaltest.map(c => c.id)).toEqual(['f1'])
  })

  it('loads mixed-case honest train and validation digests', () => {
    const { root } = dataset()
    const trainMixed = toMixedCase(digestOfSiblingFile(root, 'train.json'))
    const validationMixed = toMixedCase(digestOfSiblingFile(root, 'validation.json'))
    expect(trainMixed).not.toBe(trainMixed.toLowerCase())
    setDeclaredSearchDigests(root, trainMixed, validationMixed)
    setHonestFinaltestDigest(root)

    expect(loadSearchDatasetOnly(root).train.map(c => c.id)).toEqual(['t1'])
    expect(loadFinaltestSplit(root).map(c => c.id)).toEqual(['f1'])
    expect(loadEvolutionDataset(root).finaltest.map(c => c.id)).toEqual(['f1'])
  })

  it('rejects a lying valid 64-hex train digest at search and dataset load', () => {
    const { root } = dataset()
    // Valid SHA-256, but of a sibling file: the manifest lies about train.
    setDeclaredSearchDigests(
      root,
      digestOfSiblingFile(root, 'validation.json'),
      digestOfSiblingFile(root, 'validation.json'),
    )
    setHonestFinaltestDigest(root)

    let searchResult: unknown = null
    try {
      searchResult = loadSearchDatasetOnly(root)
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(/train file digest mismatch vs manifest/)
    }
    // The finaltest holdout is never returned as search cases.
    expect(searchResult).toBeNull()
    expect(() => loadEvolutionDataset(root)).toThrow(/train file digest mismatch vs manifest/)
  })

  it('rejects a lying valid 64-hex validation digest at search and dataset load', () => {
    const { root } = dataset()
    setDeclaredSearchDigests(
      root,
      digestOfSiblingFile(root, 'train.json'),
      digestOfSiblingFile(root, 'train.json'),
    )
    setHonestFinaltestDigest(root)

    expect(() => loadSearchDatasetOnly(root)).toThrow(
      /validation file digest mismatch vs manifest/,
    )
    expect(() => loadEvolutionDataset(root)).toThrow(
      /validation file digest mismatch vs manifest/,
    )
  })

  it('rejects a declared 64-hex train digest when the train file is missing', () => {
    const { root } = dataset()
    setDeclaredSearchDigests(root, digestOfSiblingFile(root, 'train.json'), '')
    setHonestFinaltestDigest(root)
    fs.rmSync(path.join(root, 'train.json'))

    expect(() => loadSearchDatasetOnly(root)).toThrow(/train file missing during search/)
  })

  it('still loads empty-string train and validation declarations', () => {
    const { root } = dataset()
    setHonestFinaltestDigest(root)
    const search = loadSearchDatasetOnly(root)
    expect(search.train.map(c => c.id)).toEqual(['t1'])
    expect(search.validation.map(c => c.id)).toEqual(['v1'])
    expect(loadEvolutionDataset(root).finaltest.map(c => c.id)).toEqual(['f1'])
  })

  it('still loads non-hex dummy train and validation declarations', () => {
    const { root } = dataset()
    setDeclaredSearchDigests(root, 'dummy-train', 'dummy-validation')
    setHonestFinaltestDigest(root)

    const search = loadSearchDatasetOnly(root)
    expect(search.train.map(c => c.id)).toEqual(['t1'])
    expect(search.validation.map(c => c.id)).toEqual(['v1'])
  })

  it('still loads the committed fixture with empty train/validation digests', () => {
    const search = loadSearchDatasetOnly(FIXTURE_DATASET_ROOT)
    expect('finaltest' in search).toBe(false)
    expect(search.train.length).toBeGreaterThan(0)
    expect(loadEvolutionDataset(FIXTURE_DATASET_ROOT).finaltest.map(c => c.id)).toEqual([
      'ho-001',
      'ho-002',
      'ho-003',
      'ho-004',
    ])
  })
})

describe('regression: train and validation case ids are disjoint during search (PR168)', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  const OVERLAP_ERROR = /^search splits share case ids: train and validation$/

  /**
   * Dataset whose train/validation files are distinct with different bytes but
   * caller-chosen cases, so shared ids can be exercised independently of the
   * file-identity and byte-identity checks.
   */
  function casesDataset(
    train: WrittenCase[],
    validation: WrittenCase[],
  ): TempDataset {
    const temp = makeDataset({ train: 'train.json', validation: 'validation.json' })
    cleanups.push(temp.cleanup)
    writeSplitCases(path.join(temp.root, 'train.json'), train)
    writeSplitCases(path.join(temp.root, 'validation.json'), validation)
    return temp
  }

  function searchText(data: {
    train: Array<{ report: { text: string } }>
    validation: Array<{ report: { text: string } }>
  }): string {
    return [...data.train, ...data.validation].map(c => c.report.text).join('\n')
  }

  it('rejects train and validation with the same single id and different bytes', () => {
    const { root } = casesDataset(
      [{ id: 'shared', text: 'train copy of the shared case' }],
      [{ id: 'shared', text: 'validation copy with different bytes' }],
    )
    // Distinct files, distinct bytes: only the case-id check can catch this.
    expect(fs.readFileSync(path.join(root, 'train.json'), 'utf8')).not.toBe(
      fs.readFileSync(path.join(root, 'validation.json'), 'utf8'),
    )

    let searchResult: unknown = null
    try {
      searchResult = loadSearchDatasetOnly(root)
    } catch (error) {
      expect((error as Error).message).toMatch(OVERLAP_ERROR)
    }
    // No train, validation, or finaltest cases were returned at search.
    expect(searchResult).toBeNull()
    expect(() => loadEvolutionDataset(root)).toThrow(OVERLAP_ERROR)
  })

  it('rejects a partial case-id overlap where each split also has a unique id', () => {
    const { root } = casesDataset(
      [
        { id: 't1', text: 'train unique' },
        { id: 'overlap', text: 'shared case in train' },
      ],
      [
        { id: 'overlap', text: 'shared case in validation' },
        { id: 'v1', text: 'validation unique' },
      ],
    )

    expect(() => loadSearchDatasetOnly(root)).toThrow(OVERLAP_ERROR)
    expect(() => loadEvolutionDataset(root)).toThrow(OVERLAP_ERROR)
  })

  it('rejects validation ids that are a subset of train ids', () => {
    const { root } = casesDataset(
      [
        { id: 'a', text: 'train a' },
        { id: 'b', text: 'train b' },
      ],
      [{ id: 'b', text: 'validation is a one-case subset of the train ids' }],
    )

    expect(() => loadSearchDatasetOnly(root)).toThrow(OVERLAP_ERROR)
    expect(() => loadEvolutionDataset(root)).toThrow(OVERLAP_ERROR)
  })

  it('still loads honest distinct case ids at search and finalize', () => {
    const { root } = casesDataset(
      [
        { id: 't1', text: 'train one' },
        { id: 't2', text: 'train two' },
      ],
      [
        { id: 'v1', text: 'validation one' },
        { id: 'v2', text: 'validation two' },
      ],
    )
    setDeclaredFinaltestDigest(root, digestOfSiblingFile(root, 'finaltest.json'))

    const search = loadSearchDatasetOnly(root)
    expect('finaltest' in search).toBe(false)
    expect(search.train.map(c => c.id)).toEqual(['t1', 't2'])
    expect(search.validation.map(c => c.id)).toEqual(['v1', 'v2'])
    expect(searchText(search)).not.toContain(CANARY)

    expect(loadFinaltestSplit(root).map(c => c.id)).toEqual(['f1'])
    expect(loadEvolutionDataset(root).finaltest.map(c => c.id)).toEqual(['f1'])
  })

  it('still loads the committed fixture with disjoint ids at search and finalize', () => {
    const search = loadSearchDatasetOnly(FIXTURE_DATASET_ROOT)
    expect('finaltest' in search).toBe(false)
    expect(search.train).toHaveLength(7)
    expect(search.validation).toHaveLength(4)
    const trainIds = new Set(search.train.map(c => c.id))
    expect(search.validation.some(c => trainIds.has(c.id))).toBe(false)
    expect(searchText(search)).not.toContain('ho-001')

    expect(loadEvolutionDataset(FIXTURE_DATASET_ROOT).finaltest.map(c => c.id)).toEqual([
      'ho-001',
      'ho-002',
      'ho-003',
      'ho-004',
    ])
  })
})

describe('regression: a split cannot repeat a case id (PR168)', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  const TRAIN_DUPLICATE = /^split has duplicate case ids: train\.json$/
  const VALIDATION_DUPLICATE = /^split has duplicate case ids: validation\.json$/
  const FINALTEST_DUPLICATE = /^split has duplicate case ids: finaltest\.json$/

  function dataset(
    train: WrittenCase[],
    validation: WrittenCase[],
    finaltest?: WrittenCase[],
  ): TempDataset {
    const temp = makeDataset({ train: 'train.json', validation: 'validation.json' })
    cleanups.push(temp.cleanup)
    writeSplitCases(path.join(temp.root, 'train.json'), train)
    writeSplitCases(path.join(temp.root, 'validation.json'), validation)
    if (finaltest) writeSplitCases(path.join(temp.root, 'finaltest.json'), finaltest)
    return temp
  }

  function searchText(data: {
    train: Array<{ report: { text: string } }>
    validation: Array<{ report: { text: string } }>
  }): string {
    return [...data.train, ...data.validation].map(c => c.report.text).join('\n')
  }

  it('rejects a train split that repeats an id on two rows with different bytes', () => {
    const { root } = dataset(
      [
        { id: 'dup', text: 'first train row' },
        { id: 'dup', text: 'second train row with different bytes' },
        { id: 't-unique', text: 'unique train row' },
      ],
      [{ id: 'v1', text: 'validation one' }],
    )
    // Distinct rows within one file: only the id-uniqueness gate can catch it.
    expect(fs.readFileSync(path.join(root, 'train.json'), 'utf8')).toContain(
      'second train row with different bytes',
    )

    let searchResult: unknown = null
    try {
      searchResult = loadSearchDatasetOnly(root)
    } catch (error) {
      expect((error as Error).message).toMatch(TRAIN_DUPLICATE)
    }
    // No train, validation, or finaltest cases were returned at search.
    expect(searchResult).toBeNull()
    expect(() => loadEvolutionDataset(root)).toThrow(TRAIN_DUPLICATE)
  })

  it('rejects a validation split that repeats an id', () => {
    const { root } = dataset(
      [{ id: 't1', text: 'train one' }],
      [
        { id: 'vdup', text: 'first validation row' },
        { id: 'vdup', text: 'second validation row with same id' },
        { id: 'v-unique', text: 'unique validation row' },
      ],
    )

    let searchResult: unknown = null
    try {
      searchResult = loadSearchDatasetOnly(root)
    } catch (error) {
      expect((error as Error).message).toMatch(VALIDATION_DUPLICATE)
    }
    expect(searchResult).toBeNull()
    expect(() => loadEvolutionDataset(root)).toThrow(VALIDATION_DUPLICATE)
  })

  it('rejects a train id repeated with contradictory expected labels', () => {
    const { root } = dataset(
      [
        { id: 'conflict', text: 'same id expects deliver', expected: 'deliver' },
        { id: 'conflict', text: 'same id expects discard', expected: 'discard' },
      ],
      [{ id: 'v1', text: 'validation one' }],
    )

    expect(() => loadSearchDatasetOnly(root)).toThrow(TRAIN_DUPLICATE)
    expect(() => loadEvolutionDataset(root)).toThrow(TRAIN_DUPLICATE)
  })

  it('rejects a non-string case id in a search split', () => {
    const { root } = dataset(
      [{ id: 't1', text: 'train one' }],
      [{ id: 'v1', text: 'validation one' }],
    )
    fs.writeFileSync(
      path.join(root, 'train.json'),
      JSON.stringify({
        cases: [
          {
            id: 7,
            speculative: true,
            report: { kind: 'ready', text: 'numeric id' },
            expected: 'deliver',
          },
        ],
      }),
    )

    expect(() => loadSearchDatasetOnly(root)).toThrow(/^split has invalid case id: /)
    expect(() => loadEvolutionDataset(root)).toThrow(/^split has invalid case id: /)
  })

  it('loads search but rejects a finaltest split that repeats an id at finalize', () => {
    const { root } = dataset(
      [{ id: 't1', text: 'train one' }],
      [{ id: 'v1', text: 'validation one' }],
      [
        { id: 'f-dup', text: 'first holdout' },
        { id: 'f-dup', text: 'second holdout with same id' },
      ],
    )
    // Honest commitment so finalize reaches the split instead of a digest error.
    setDeclaredFinaltestDigest(root, digestOfSiblingFile(root, 'finaltest.json'))

    const search = loadSearchDatasetOnly(root)
    expect('finaltest' in search).toBe(false)
    expect(search.train.map(c => c.id)).toEqual(['t1'])
    expect(search.validation.map(c => c.id)).toEqual(['v1'])
    expect(searchText(search)).not.toContain('first holdout')

    expect(() => loadFinaltestSplit(root)).toThrow(FINALTEST_DUPLICATE)
    expect(() => loadEvolutionDataset(root)).toThrow(FINALTEST_DUPLICATE)
  })

  it('still loads honest distinct case ids at search and finalize', () => {
    const { root } = dataset(
      [
        { id: 't1', text: 'train one' },
        { id: 't2', text: 'train two' },
      ],
      [
        { id: 'v1', text: 'validation one' },
        { id: 'v2', text: 'validation two' },
      ],
    )
    setDeclaredFinaltestDigest(root, digestOfSiblingFile(root, 'finaltest.json'))

    const search = loadSearchDatasetOnly(root)
    expect('finaltest' in search).toBe(false)
    expect(search.train.map(c => c.id)).toEqual(['t1', 't2'])
    expect(search.validation.map(c => c.id)).toEqual(['v1', 'v2'])
    expect(searchText(search)).not.toContain(CANARY)

    expect(loadFinaltestSplit(root).map(c => c.id)).toEqual(['f1'])
    expect(loadEvolutionDataset(root).finaltest.map(c => c.id)).toEqual(['f1'])
  })

  it('still loads the committed fixture with unique ids at search and finalize', () => {
    const search = loadSearchDatasetOnly(FIXTURE_DATASET_ROOT)
    expect('finaltest' in search).toBe(false)
    expect(search.train).toHaveLength(7)
    expect(search.validation).toHaveLength(4)
    expect(new Set(search.train.map(c => c.id)).size).toBe(search.train.length)
    expect(new Set(search.validation.map(c => c.id)).size).toBe(search.validation.length)
    expect(searchText(search)).not.toContain('ho-001')

    expect(loadFinaltestSplit(FIXTURE_DATASET_ROOT).map(c => c.id)).toEqual([
      'ho-001',
      'ho-002',
      'ho-003',
      'ho-004',
    ])
    expect(loadEvolutionDataset(FIXTURE_DATASET_ROOT).finaltest.map(c => c.id)).toEqual([
      'ho-001',
      'ho-002',
      'ho-003',
      'ho-004',
    ])
  })
})

describe('regression: a split must carry a valid expected label (PR168)', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  const TRAIN_INVALID = /^split has invalid expected label: train\.json$/
  const VALIDATION_INVALID = /^split has invalid expected label: validation\.json$/
  const FINALTEST_INVALID = /^split has invalid expected label: finaltest\.json$/

  function dataset(
    train: WrittenCase[],
    validation: WrittenCase[],
    finaltest?: WrittenCase[],
  ): TempDataset {
    const temp = makeDataset({ train: 'train.json', validation: 'validation.json' })
    cleanups.push(temp.cleanup)
    writeSplitCases(path.join(temp.root, 'train.json'), train)
    writeSplitCases(path.join(temp.root, 'validation.json'), validation)
    if (finaltest) writeSplitCases(path.join(temp.root, 'finaltest.json'), finaltest)
    return temp
  }

  function searchText(data: {
    train: Array<{ report: { text: string } }>
    validation: Array<{ report: { text: string } }>
  }): string {
    return [...data.train, ...data.validation].map(c => c.report.text).join('\n')
  }

  it('rejects a train split whose expected label is the wrong case', () => {
    const { root } = dataset(
      [
        { id: 'bad', text: 'wrong-case label', expected: 'Deliver' },
        { id: 'ok', text: 'honest unique row', expected: 'discard' },
      ],
      [{ id: 'v1', text: 'validation one', expected: 'deliver' }],
    )

    let searchResult: unknown = null
    try {
      searchResult = loadSearchDatasetOnly(root)
    } catch (error) {
      expect((error as Error).message).toMatch(TRAIN_INVALID)
    }
    // No train, validation, or finaltest cases were returned at search.
    expect(searchResult).toBeNull()
    expect(() => loadEvolutionDataset(root)).toThrow(TRAIN_INVALID)
  })

  it('rejects a train split whose expected label is not an enum value', () => {
    const { root } = dataset(
      [
        { id: 'bad', text: 'not-a-label', expected: 'yes' },
        { id: 'ok', text: 'honest unique row', expected: 'discard' },
      ],
      [{ id: 'v1', text: 'validation one', expected: 'deliver' }],
    )

    expect(() => loadSearchDatasetOnly(root)).toThrow(TRAIN_INVALID)
    expect(() => loadEvolutionDataset(root)).toThrow(TRAIN_INVALID)
  })

  it('rejects a train split that omits expected', () => {
    const { root } = dataset(
      [
        { id: 'bad', text: 'missing label', omitExpected: true },
        { id: 'ok', text: 'honest unique row', expected: 'discard' },
      ],
      [{ id: 'v1', text: 'validation one', expected: 'deliver' }],
    )

    expect(() => loadSearchDatasetOnly(root)).toThrow(TRAIN_INVALID)
    expect(() => loadEvolutionDataset(root)).toThrow(TRAIN_INVALID)
  })

  it('rejects a train split with a null expected label', () => {
    const { root } = dataset(
      [
        { id: 'bad', text: 'null label', expected: null },
        { id: 'ok', text: 'honest unique row', expected: 'discard' },
      ],
      [{ id: 'v1', text: 'validation one', expected: 'deliver' }],
    )

    expect(() => loadSearchDatasetOnly(root)).toThrow(TRAIN_INVALID)
    expect(() => loadEvolutionDataset(root)).toThrow(TRAIN_INVALID)
  })

  it('rejects a train split with an empty expected label', () => {
    const { root } = dataset(
      [
        { id: 'bad', text: 'empty label', expected: '' },
        { id: 'ok', text: 'honest unique row', expected: 'discard' },
      ],
      [{ id: 'v1', text: 'validation one', expected: 'deliver' }],
    )

    expect(() => loadSearchDatasetOnly(root)).toThrow(TRAIN_INVALID)
    expect(() => loadEvolutionDataset(root)).toThrow(TRAIN_INVALID)
  })

  it('rejects a validation split with an invalid expected label', () => {
    const { root } = dataset(
      [{ id: 't1', text: 'train one', expected: 'deliver' }],
      [{ id: 'vbad', text: 'wrong-case validation label', expected: 'Deliver' }],
    )

    expect(() => loadSearchDatasetOnly(root)).toThrow(VALIDATION_INVALID)
    expect(() => loadEvolutionDataset(root)).toThrow(VALIDATION_INVALID)
  })

  it('keeps search working when only the sealed finaltest label is invalid', () => {
    const { root } = dataset(
      [{ id: 't1', text: 'train one', expected: 'deliver' }],
      [{ id: 'v1', text: 'validation one', expected: 'discard' }],
      [
        { id: 'f1', text: `held-out case ${CANARY}`, expected: 'Deliver' },
        { id: 'f2', text: 'honest holdout', expected: 'discard' },
      ],
    )
    // Honest commitment so finalize reaches the split instead of a digest error.
    setDeclaredFinaltestDigest(root, digestOfSiblingFile(root, 'finaltest.json'))

    const search = loadSearchDatasetOnly(root)
    expect('finaltest' in search).toBe(false)
    expect(search.train.map(c => c.id)).toEqual(['t1'])
    expect(search.validation.map(c => c.id)).toEqual(['v1'])
    expect(searchText(search)).not.toContain(CANARY)

    expect(() => loadFinaltestSplit(root)).toThrow(FINALTEST_INVALID)
    expect(() => loadEvolutionDataset(root)).toThrow(FINALTEST_INVALID)
  })

  it('still loads honest labels at search and finalize', () => {
    const { root } = dataset(
      [
        { id: 't1', text: 'deliver label', expected: 'deliver' },
        { id: 't2', text: 'discard label', expected: 'discard' },
      ],
      [
        { id: 'v1', text: 'validation deliver', expected: 'deliver' },
        { id: 'v2', text: 'validation discard', expected: 'discard' },
      ],
      [{ id: 'f1', text: 'honest holdout', expected: 'discard' }],
    )
    setDeclaredFinaltestDigest(root, digestOfSiblingFile(root, 'finaltest.json'))

    const search = loadSearchDatasetOnly(root)
    expect('finaltest' in search).toBe(false)
    expect(search.train.map(c => c.expected)).toEqual(['deliver', 'discard'])
    expect(search.validation.map(c => c.expected)).toEqual(['deliver', 'discard'])
    expect(searchText(search)).not.toContain(CANARY)

    expect(loadFinaltestSplit(root).map(c => c.id)).toEqual(['f1'])
    expect(loadEvolutionDataset(root).finaltest.map(c => c.id)).toEqual(['f1'])
  })

  it('still loads the committed fixture with honest labels at search and finalize', () => {
    const search = loadSearchDatasetOnly(FIXTURE_DATASET_ROOT)
    expect('finaltest' in search).toBe(false)
    expect(search.train).toHaveLength(7)
    expect(search.validation).toHaveLength(4)
    for (const testCase of [...search.train, ...search.validation]) {
      expect(['deliver', 'discard']).toContain(testCase.expected)
    }
    expect(searchText(search)).not.toContain('ho-001')

    expect(loadEvolutionDataset(FIXTURE_DATASET_ROOT).finaltest.map(c => c.id)).toEqual([
      'ho-001',
      'ho-002',
      'ho-003',
      'ho-004',
    ])
  })
})

describe('regression: a split must carry a valid speculative flag (PR168)', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  const TRAIN_INVALID = /^split has invalid speculative flag: train\.json$/
  const VALIDATION_INVALID = /^split has invalid speculative flag: validation\.json$/
  const FINALTEST_INVALID = /^split has invalid speculative flag: finaltest\.json$/

  function dataset(
    train: WrittenCase[],
    validation: WrittenCase[],
    finaltest?: WrittenCase[],
  ): TempDataset {
    const temp = makeDataset({ train: 'train.json', validation: 'validation.json' })
    cleanups.push(temp.cleanup)
    writeSplitCases(path.join(temp.root, 'train.json'), train)
    writeSplitCases(path.join(temp.root, 'validation.json'), validation)
    if (finaltest) writeSplitCases(path.join(temp.root, 'finaltest.json'), finaltest)
    return temp
  }

  function searchText(data: {
    train: Array<{ report: { text: string } }>
    validation: Array<{ report: { text: string } }>
  }): string {
    return [...data.train, ...data.validation].map(c => c.report.text).join('\n')
  }

  it('rejects a train split with a string "true" speculative flag', () => {
    const { root } = dataset(
      [
        { id: 'bad', text: 'string true flag', speculative: 'true' },
        { id: 'ok', text: 'honest unique row', speculative: true },
      ],
      [{ id: 'v1', text: 'validation one', speculative: true }],
    )

    let searchResult: unknown = null
    try {
      searchResult = loadSearchDatasetOnly(root)
    } catch (error) {
      expect((error as Error).message).toMatch(TRAIN_INVALID)
    }
    // No train, validation, or finaltest cases were returned at search.
    expect(searchResult).toBeNull()
    expect(() => loadEvolutionDataset(root)).toThrow(TRAIN_INVALID)
  })

  it('rejects a train split with a string "false" speculative flag', () => {
    // "false" is truthy, so it would silently take the speculative path.
    const { root } = dataset(
      [
        { id: 'bad', text: 'string false flag', speculative: 'false' },
        { id: 'ok', text: 'honest unique row', speculative: true },
      ],
      [{ id: 'v1', text: 'validation one', speculative: true }],
    )

    let searchResult: unknown = null
    try {
      searchResult = loadSearchDatasetOnly(root)
    } catch (error) {
      expect((error as Error).message).toMatch(TRAIN_INVALID)
    }
    expect(searchResult).toBeNull()
    expect(() => loadEvolutionDataset(root)).toThrow(TRAIN_INVALID)
  })

  const INVALID_TRAIN_FLAGS: Array<[string, WrittenCase]> = [
    ['omits speculative', { id: 'bad', text: 'missing flag', omitSpeculative: true }],
    ['sets speculative to null', { id: 'bad', text: 'null flag', speculative: null }],
    ['sets speculative to 0', { id: 'bad', text: 'zero flag', speculative: 0 }],
    ['sets speculative to 1', { id: 'bad', text: 'one flag', speculative: 1 }],
  ]

  it.each(INVALID_TRAIN_FLAGS)(
    'rejects a train split that %s',
    (_label, badCase) => {
      const { root } = dataset(
        [badCase, { id: 'ok', text: 'honest unique row', speculative: true }],
        [{ id: 'v1', text: 'validation one', speculative: true }],
      )

      let searchResult: unknown = null
      try {
        searchResult = loadSearchDatasetOnly(root)
      } catch (error) {
        expect((error as Error).message).toMatch(TRAIN_INVALID)
      }
      expect(searchResult).toBeNull()
      expect(() => loadEvolutionDataset(root)).toThrow(TRAIN_INVALID)
    },
  )

  it('rejects a validation split with a string "false" speculative flag', () => {
    const { root } = dataset(
      [{ id: 't1', text: 'train one', speculative: true }],
      [{ id: 'vbad', text: 'string false validation flag', speculative: 'false' }],
    )

    expect(() => loadSearchDatasetOnly(root)).toThrow(VALIDATION_INVALID)
    expect(() => loadEvolutionDataset(root)).toThrow(VALIDATION_INVALID)
  })

  it('keeps search working when only the sealed finaltest flag is invalid', () => {
    const { root } = dataset(
      [{ id: 't1', text: 'train one', speculative: true }],
      [{ id: 'v1', text: 'validation one', speculative: true }],
      [
        { id: 'f1', text: `held-out case ${CANARY}`, speculative: 'true' },
        { id: 'f2', text: 'honest holdout', speculative: true },
      ],
    )
    // Honest commitment so finalize reaches the split instead of a digest error.
    setDeclaredFinaltestDigest(root, digestOfSiblingFile(root, 'finaltest.json'))

    const search = loadSearchDatasetOnly(root)
    expect('finaltest' in search).toBe(false)
    expect(search.train.map(c => c.id)).toEqual(['t1'])
    expect(search.validation.map(c => c.id)).toEqual(['v1'])
    expect(searchText(search)).not.toContain(CANARY)

    expect(() => loadFinaltestSplit(root)).toThrow(FINALTEST_INVALID)
    expect(() => loadEvolutionDataset(root)).toThrow(FINALTEST_INVALID)
  })

  it('still loads honest boolean flags at search and finalize', () => {
    const { root } = dataset(
      [
        { id: 't1', text: 'speculative train row', speculative: true },
        { id: 't2', text: 'non-speculative train row', speculative: false },
      ],
      [
        { id: 'v1', text: 'speculative validation row', speculative: true },
        { id: 'v2', text: 'non-speculative validation row', speculative: false },
      ],
      [
        { id: 'f1', text: 'speculative holdout', speculative: true },
        { id: 'f2', text: 'non-speculative holdout', speculative: false },
      ],
    )
    setDeclaredFinaltestDigest(root, digestOfSiblingFile(root, 'finaltest.json'))

    const search = loadSearchDatasetOnly(root)
    expect('finaltest' in search).toBe(false)
    expect(search.train.map(c => c.speculative)).toEqual([true, false])
    expect(search.validation.map(c => c.speculative)).toEqual([true, false])
    expect(searchText(search)).not.toContain(CANARY)

    expect(loadFinaltestSplit(root).map(c => [c.id, c.speculative])).toEqual([
      ['f1', true],
      ['f2', false],
    ])
    expect(loadEvolutionDataset(root).finaltest.map(c => c.speculative)).toEqual([true, false])
  })

  it('still loads the committed fixture with boolean flags at search and finalize', () => {
    const search = loadSearchDatasetOnly(FIXTURE_DATASET_ROOT)
    expect('finaltest' in search).toBe(false)
    expect(search.train).toHaveLength(7)
    expect(search.validation).toHaveLength(4)
    for (const testCase of [...search.train, ...search.validation]) {
      expect(typeof testCase.speculative).toBe('boolean')
    }
    expect(searchText(search)).not.toContain('ho-001')

    expect(loadFinaltestSplit(FIXTURE_DATASET_ROOT).map(c => c.id)).toEqual([
      'ho-001',
      'ho-002',
      'ho-003',
      'ho-004',
    ])
    expect(loadEvolutionDataset(FIXTURE_DATASET_ROOT).finaltest.map(c => c.speculative)).toEqual([
      true,
      true,
      true,
      true,
    ])
  })
})

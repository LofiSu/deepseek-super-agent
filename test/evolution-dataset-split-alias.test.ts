import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadEvolutionDataset, loadSearchDatasetOnly } from '../src/evolution/dataset.ts'

const CANARY = 'SECRET_HOLDOUT_TOKEN'
const OUTSIDE_CANARY = 'SECRET_OUTSIDE_TOKEN'

function writeSplit(file: string, id: string, text: string): void {
  fs.writeFileSync(
    file,
    JSON.stringify({
      cases: [{ id, speculative: true, report: { kind: 'ready', text }, expected: 'deliver' }],
    }),
  )
}

interface TempDataset {
  root: string
  cleanup: () => void
}

function makeDataset(splits: { train: string; validation: string }): TempDataset {
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
      splitDigests: { train: '', validation: '', finaltest: 'unused-by-search-phase' },
      seed: 20260308,
    }),
  )
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
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
})

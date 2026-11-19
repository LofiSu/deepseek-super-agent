import fs from 'node:fs'
import path from 'node:path'
import { sha256File, stableJsonDigest } from './digest.ts'

/** LABEL synthetic dataset for multi-step two-round demos (temp dir only). */
export function writeSynthDataset(targetDir: string): {
  targetDir: string
  manifest: Record<string, unknown>
  datasetDigest: string
} {
  fs.mkdirSync(targetDir, { recursive: true })
  const train = {
    cases: [
      {
        id: 'tr-glimmer',
        speculative: true,
        report: { kind: 'ready', text: 'glimmer linkage complete for deploy.' },
        expected: 'deliver',
      },
      {
        id: 'tr-orbit',
        speculative: true,
        report: { kind: 'ready', text: 'orbit linkage complete for deploy.' },
        expected: 'deliver',
      },
      {
        id: 'tr-neutral',
        speculative: true,
        report: { kind: 'ready', text: 'neutral checkpoint complete for deploy.' },
        expected: 'deliver',
      },
    ],
  }
  const validation = {
    cases: [
      {
        id: 'va-keep',
        speculative: true,
        report: { kind: 'ready', text: 'fixed and ready to ship.' },
        expected: 'deliver',
      },
      {
        id: 'va-glimmer-trap',
        speculative: true,
        report: { kind: 'ready', text: 'glimmer shadow only; cannot ship this build.' },
        expected: 'discard',
      },
    ],
  }
  const finaltest = {
    cases: [
      {
        id: 'ft-a',
        speculative: true,
        report: { kind: 'ready', text: 'orbit fix validated.' },
        expected: 'deliver',
      },
      {
        id: 'ft-b',
        speculative: true,
        report: { kind: 'note', text: 'no change worth delivering.' },
        expected: 'discard',
      },
    ],
  }
  fs.writeFileSync(path.join(targetDir, 'train.json'), JSON.stringify(train, null, 2))
  fs.writeFileSync(path.join(targetDir, 'validation.json'), JSON.stringify(validation, null, 2))
  fs.writeFileSync(path.join(targetDir, 'finaltest.json'), JSON.stringify(finaltest, null, 2))
  const finaltestDigest = sha256File(path.join(targetDir, 'finaltest.json'))
  const manifest = {
    schemaVersion: 2,
    domain: 'deliver-gate-v1',
    splits: { train: 'train.json', validation: 'validation.json', finaltest: 'finaltest.json' },
    splitDigests: {
      train: sha256File(path.join(targetDir, 'train.json')),
      validation: sha256File(path.join(targetDir, 'validation.json')),
      finaltest: finaltestDigest,
    },
    seed: 424242,
  }
  fs.writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  const datasetDigest = stableJsonDigest([
    sha256File(path.join(targetDir, 'manifest.json')),
    sha256File(path.join(targetDir, 'train.json')),
    sha256File(path.join(targetDir, 'validation.json')),
    finaltestDigest,
  ])
  return { targetDir, manifest, datasetDigest }
}

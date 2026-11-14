/**
 * Copy runtime assets that tsc does not emit into dist.
 *
 * Keep this list in sync with the non-.ts files the runtime loads; the
 * packaging smoke script asserts each emitted asset is in the tarball. The
 * evaluator child ships under dist/scripts so a published package can run it
 * with plain node (no tsx, no src/).
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assets = [
  { from: 'src/watchdog/rules.json', to: 'dist/watchdog/rules.json' },
  { from: 'scripts/evolution-eval-child.mjs', to: 'dist/scripts/evolution-eval-child.mjs' },
]

for (const asset of assets) {
  const from = path.join(root, asset.from)
  const to = path.join(root, asset.to)
  mkdirSync(path.dirname(to), { recursive: true })
  copyFileSync(from, to)
}

console.log(`copied ${assets.length} asset(s) to dist: ${assets.map(asset => asset.to).join(', ')}`)

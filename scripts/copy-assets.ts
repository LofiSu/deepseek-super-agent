/**
 * Copy runtime assets that tsc does not emit into dist.
 *
 * Keep this list in sync with non-.ts files under src/; the packaging smoke
 * script asserts the emitted asset is in the tarball.
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assets = ['watchdog/rules.json']

for (const asset of assets) {
  const from = path.join(root, 'src', asset)
  const to = path.join(root, 'dist', asset)
  mkdirSync(path.dirname(to), { recursive: true })
  copyFileSync(from, to)
}

console.log(`copied ${assets.length} asset(s) to dist: ${assets.join(', ')}`)

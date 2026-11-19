/**
 * Copy runtime assets that tsc does not emit into dist.
 *
 * Keep this list in sync with non-.ts files under src/; the packaging smoke
 * script asserts every emitted asset is in the tarball.
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Non-.ts files under `src/` that the published package needs at runtime. */
export const RUNTIME_ASSETS = [
  'watchdog/rules.json',
  'env/fixtures/sandbox-loopback-server.mjs',
  'env/fixtures/sandbox-external-pid-fixture.mjs',
] as const

export function copyRuntimeAssets(repoRoot: string = root): void {
  for (const asset of RUNTIME_ASSETS) {
    const from = path.join(repoRoot, 'src', asset)
    const to = path.join(repoRoot, 'dist', asset)
    mkdirSync(path.dirname(to), { recursive: true })
    copyFileSync(from, to)
  }
}

function main(): void {
  copyRuntimeAssets()
  console.log(`copied ${RUNTIME_ASSETS.length} asset(s) to dist: ${RUNTIME_ASSETS.join(', ')}`)
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === entry) main()

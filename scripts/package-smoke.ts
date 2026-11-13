/**
 * Packaging smoke check.
 *
 * Manual/CI-only: builds the dist CLI, runs it with plain node, and asks the
 * package manager which files would ship. It is intentionally not part of the
 * unit suite (see test/packaging.test.ts for the fast structural checks).
 *
 * Run with: pnpm tsx scripts/package-smoke.ts
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { RUNTIME_ASSETS } from './copy-assets.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distEntry = path.join(root, 'dist', 'cli', 'main.js')
const failures: string[] = []
let passed = 0

function run(command: string, args: string[]): { status: number | null; output: string } {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })
  if (result.error) throw result.error
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  }
}

function check(label: string, condition: boolean, detail: string): void {
  if (condition) {
    passed += 1
    console.log(`ok   ${label}`)
    return
  }
  failures.push(`${label}${detail ? `\n     ${detail}` : ''}`)
  console.error(`FAIL ${label}`)
  if (detail) console.error(`     ${detail}`)
}

function finish(): never {
  const total = passed + failures.length
  if (failures.length > 0) {
    console.error(`\npackage smoke: ${failures.length}/${total} check(s) failed`)
    process.exit(1)
  }
  console.log(`\npackage smoke: ${passed}/${total} check(s) passed`)
  process.exit(0)
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  version?: string
  bin?: Record<string, string>
  files?: string[]
}

console.log('package smoke: building dist')
const build = run('pnpm', ['build'])
check('pnpm build exits 0', build.status === 0, build.output)
if (build.status !== 0) finish()

check('dist/cli/main.js exists', existsSync(distEntry), `missing ${distEntry}`)
for (const asset of RUNTIME_ASSETS) {
  const distAsset = path.join(root, 'dist', asset)
  const srcAsset = path.join(root, 'src', asset)
  check(`dist/${asset} exists`, existsSync(distAsset), `missing ${distAsset}`)
  check(
    `dist/${asset} matches src asset`,
    existsSync(distAsset) && readFileSync(distAsset, 'utf8') === readFileSync(srcAsset, 'utf8'),
    `compare ${distAsset}`,
  )
}

// The shipped probe resolves its fixtures from beside the compiled module. This
// is the production path that the source-only test/fixtures tree cannot serve.
const probeModule = pathToFileURL(path.join(root, 'dist', 'env', 'sandbox-probe.js')).href
const probeRuntime = run('node', ['--input-type=module', '-e', [
  `import { existsSync } from 'node:fs'`,
  `import { sandboxProbeFixturePaths } from ${JSON.stringify(probeModule)}`,
  `const paths = sandboxProbeFixturePaths()`,
  `console.log(JSON.stringify({ loopback: existsSync(paths.loopback), externalPid: existsSync(paths.externalPid), loopbackPath: paths.loopback }))`,
].join(';')])
let probeLayout: { loopback?: boolean; externalPid?: boolean; loopbackPath?: string } = {}
try {
  probeLayout = JSON.parse(probeRuntime.output) as typeof probeLayout
} catch {
  // Reported by the check below.
}
check('compiled sandbox probe loads', probeRuntime.status === 0, probeRuntime.output)
check(
  'compiled sandbox probe resolves fixtures inside dist',
  probeLayout.loopback === true
    && probeLayout.externalPid === true
    && typeof probeLayout.loopbackPath === 'string'
    && probeLayout.loopbackPath.startsWith(path.join(root, 'dist', 'env', 'fixtures') + path.sep),
  probeRuntime.output,
)

const binTarget = pkg.bin?.['ds-agent']
check(
  'package.json bin.ds-agent targets dist/cli/main.js',
  binTarget === './dist/cli/main.js',
  `got ${JSON.stringify(binTarget)}`,
)
check('package.json files includes dist', pkg.files?.includes('dist') === true, `got ${JSON.stringify(pkg.files)}`)

const help = run('node', [distEntry, '--help'])
check('node dist/cli/main.js --help exits 0', help.status === 0, help.output)
check(
  'help prints usage text',
  help.output.includes('ds-agent') && help.output.includes('ds-agent init'),
  help.output.slice(0, 200),
)

const version = run('node', [distEntry, '--version'])
check('node dist/cli/main.js --version exits 0', version.status === 0, version.output)
check(
  'built CLI prints the package version',
  version.output === pkg.version,
  `expected ${JSON.stringify(pkg.version)} got ${JSON.stringify(version.output)}`,
)

console.log('package smoke: checking tarball contents')
// pnpm 9 does not implement `pnpm pack --dry-run`; npm is the fallback the
// contract allows. npm still runs the `prepack` script above.
const pack = run('npm', ['pack', '--dry-run'])
check('npm pack --dry-run exits 0', pack.status === 0, pack.output)
check('tarball file list contains dist/cli/main.js', pack.output.includes('dist/cli/main.js'), pack.output)
for (const asset of RUNTIME_ASSETS) {
  check(`tarball file list contains dist/${asset}`, pack.output.includes(`dist/${asset}`), pack.output)
}
check('tarball file list contains package.json (bin entry)', pack.output.includes('package.json'), pack.output)
check(
  'bin target is in the files whitelist',
  typeof binTarget === 'string' && binTarget.replace(/^\.\//, '').startsWith('dist/'),
  `bin ${JSON.stringify(binTarget)} files ${JSON.stringify(pkg.files)}`,
)

finish()

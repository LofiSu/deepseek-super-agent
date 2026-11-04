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
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distEntry = path.join(root, 'dist', 'cli', 'main.js')
const failures: string[] = []
let passed = 0

function run(command: string, args: string[]): { status: number | null; output: string } {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' })
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
  bin?: Record<string, string>
  files?: string[]
}

console.log('package smoke: building dist')
const build = run('pnpm', ['build'])
check('pnpm build exits 0', build.status === 0, build.output)
if (build.status !== 0) finish()

check('dist/cli/main.js exists', existsSync(distEntry), `missing ${distEntry}`)

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

console.log('package smoke: checking tarball contents')
// pnpm 9 does not implement `pnpm pack --dry-run`; npm is the fallback the
// contract allows. npm still runs the `prepack` script above.
const pack = run('npm', ['pack', '--dry-run'])
check('npm pack --dry-run exits 0', pack.status === 0, pack.output)
check('tarball file list contains dist/cli/main.js', pack.output.includes('dist/cli/main.js'), pack.output)
check('tarball file list contains package.json (bin entry)', pack.output.includes('package.json'), pack.output)
check(
  'bin target is in the files whitelist',
  typeof binTarget === 'string' && binTarget.replace(/^\.\//, '').startsWith('dist/'),
  `bin ${JSON.stringify(binTarget)} files ${JSON.stringify(pkg.files)}`,
)

finish()

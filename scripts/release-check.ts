/**
 * Release manifest and artifact check.
 *
 * This is a pre-release gate, not a publisher. It verifies the parts of the
 * package that users actually install:
 *  - `package.json` has a semver version and a `ds-agent` bin pointing at
 *    `dist/cli/main.js`;
 *  - the build emitted the CLI entry and the runtime rules asset;
 *  - `npm pack --dry-run --json` would ship `dist/` and the entry points.
 *
 * Run after `pnpm build`:
 *
 *   npx tsx scripts/release-check.ts
 *
 * Every failure is printed with a next action, and the process exits 1.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { RUNTIME_ASSETS } from './copy-assets.ts'

export interface ReleaseCheckOptions {
  /** Repository root. Defaults to the parent of this script. */
  readonly root?: string
  /**
   * Injection point for tests. Defaults to running
   * `npm pack --dry-run --json` in the repository root.
   */
  readonly pack?: (root: string) => { status: number | null; stdout: string; stderr: string }
}

export interface ReleaseCheck {
  readonly id: string
  readonly ok: boolean
  readonly message: string
  readonly detail?: string
}

export interface ReleaseCheckResult {
  readonly ok: boolean
  readonly checks: readonly ReleaseCheck[]
  readonly errors: readonly string[]
}

export const CLI_ENTRY = 'dist/cli/main.js'

/**
 * The build copies the watchdog rules asset to `dist/watchdog/rules.json`.
 * `dist/channels/rules.json` is accepted as the historical layout so this
 * check keeps working for older tarballs and fixtures.
 */
export const RULES_ASSET_CANDIDATES = [
  'dist/channels/rules.json',
  'dist/watchdog/rules.json',
] as const

/**
 * Host-side fixtures the sandbox probe loads from beside the compiled module.
 * Without them `DS_AGENT_SANDBOX_REQUIRED=network|process` can never pass in an
 * installed package, so the tarball must ship them.
 */
export const SANDBOX_PROBE_ASSETS: readonly string[] = RUNTIME_ASSETS
  .filter(asset => asset.startsWith('env/fixtures/'))
  .map(asset => `dist/${asset}`)

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

interface PackageManifest {
  version?: unknown
  bin?: unknown
  files?: unknown
}

interface PackEntry {
  path?: unknown
}

interface PackFile {
  files?: unknown
}

function defaultRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function binTarget(bin: unknown): string | undefined {
  if (typeof bin === 'string') return bin
  if (bin && typeof bin === 'object' && 'ds-agent' in bin) {
    const value = (bin as Record<string, unknown>)['ds-agent']
    return typeof value === 'string' ? value : undefined
  }
  return undefined
}

function normalizePackPath(value: string): string {
  return value.replace(/^\.\//, '')
}

function parsePackFiles(stdout: string): string[] {
  // npm may print lifecycle-script output before the JSON array. Try the whole
  // output, then each `[` from the end; the real payload is the trailing array.
  const candidates = [stdout.trim()]
  let index = stdout.lastIndexOf('[')
  while (index > 0) {
    candidates.push(stdout.slice(index).trim())
    index = stdout.lastIndexOf('[', index - 1)
  }

  let parsed: unknown
  let parseError: unknown
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      parsed = JSON.parse(candidate)
      break
    } catch (error) {
      parseError = error
    }
  }
  if (parsed === undefined) {
    throw parseError instanceof Error ? parseError : new Error('no JSON array in npm pack output')
  }

  const entries = Array.isArray(parsed) ? parsed : [parsed]
  const files: string[] = []
  for (const entry of entries as PackFile[]) {
    if (!Array.isArray(entry?.files)) continue
    for (const file of entry.files as PackEntry[]) {
      if (typeof file?.path === 'string') files.push(normalizePackPath(file.path))
    }
  }
  return files
}

function failed(id: string, message: string, detail?: string): ReleaseCheck {
  return detail === undefined ? { id, ok: false, message } : { id, ok: false, message, detail }
}

function passed(id: string, message: string, detail?: string): ReleaseCheck {
  return detail === undefined ? { id, ok: true, message } : { id, ok: true, message, detail }
}

/** Run every check and collect failures instead of stopping at the first. */
export function checkRelease(options: ReleaseCheckOptions = {}): ReleaseCheckResult {
  const root = path.resolve(options.root ?? defaultRoot())
  const checks: ReleaseCheck[] = []

  const packageJsonPath = path.join(root, 'package.json')
  let pkg: PackageManifest | undefined
  try {
    pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageManifest
    checks.push(passed('package-json', `package.json is readable at ${packageJsonPath}`))
  } catch (error) {
    checks.push(failed(
      'package-json',
      `cannot read ${packageJsonPath}; run this from the repository root`,
      errorMessage(error),
    ))
  }

  if (pkg) {
    const version = pkg.version
    checks.push(
      typeof version === 'string' && SEMVER.test(version)
        ? passed('version', `version ${version} is semver`)
        : failed(
          'version',
          'package.json version must be semver (for example 0.1.0 or 0.2.0-rc.1)',
          `got ${JSON.stringify(version)}`,
        ),
    )

    const target = binTarget(pkg.bin)
    const normalized = target === undefined ? undefined : normalizePackPath(target)
    checks.push(
      normalized === CLI_ENTRY
        ? passed('bin', `bin.ds-agent points at ${CLI_ENTRY}`)
        : failed(
          'bin',
          `package.json bin.ds-agent must be "./${CLI_ENTRY}"`,
          `got ${JSON.stringify(target ?? pkg.bin)}`,
        ),
    )

    const files = Array.isArray(pkg.files) ? pkg.files : []
    checks.push(
      files.includes('dist')
        ? passed('files', 'package.json files includes dist')
        : failed(
          'files',
          'package.json "files" must include "dist" or the tarball ships no CLI',
          `got ${JSON.stringify(pkg.files)}`,
        ),
    )
  }

  const entryPath = path.join(root, CLI_ENTRY)
  checks.push(
    isFile(entryPath)
      ? passed('dist-entry', `${CLI_ENTRY} exists after build`)
      : failed(
        'dist-entry',
        `build artifact missing: ${CLI_ENTRY}; run "pnpm build"`,
        entryPath,
      ),
  )

  const existingRules = RULES_ASSET_CANDIDATES
    .map(candidate => path.join(root, candidate))
    .filter(isFile)
  checks.push(
    existingRules.length > 0
      ? passed('dist-rules', `runtime rules asset exists (${path.relative(root, existingRules[0]!)})`)
      : failed(
        'dist-rules',
        'runtime rules asset missing; the build must emit dist/watchdog/rules.json '
        + '(dist/channels/rules.json is also accepted)',
        RULES_ASSET_CANDIDATES.join(' or '),
      ),
  )

  const missingProbeAssets = SANDBOX_PROBE_ASSETS.filter(candidate => !isFile(path.join(root, candidate)))
  checks.push(
    missingProbeAssets.length === 0
      ? passed('dist-probe-assets', `sandbox probe fixtures exist (${SANDBOX_PROBE_ASSETS.join(', ')})`)
      : failed(
        'dist-probe-assets',
        'sandbox probe fixtures missing; the build must emit them under dist/env/fixtures/',
        missingProbeAssets.join(', '),
      ),
  )

  const runPack = options.pack ?? (repoRoot => {
    // The check already requires a built tree, so skip prepack's second build.
    const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 180_000,
    })
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    }
  })

  try {
    const pack = runPack(root)
    if (pack.status !== 0) {
      checks.push(failed(
        'pack',
        'npm pack --dry-run --json failed; run it manually in the repository root',
        `${pack.stderr}${pack.stdout}`.trim().slice(0, 2_000),
      ))
    } else {
      checks.push(passed('pack', 'npm pack --dry-run --json succeeded'))
      let files: string[]
      try {
        files = parsePackFiles(pack.stdout)
      } catch (error) {
        files = []
        checks.push(failed(
          'pack-json',
          'could not parse the npm pack JSON output',
          errorMessage(error),
        ))
      }

      const distFiles = files.filter(file => file === 'dist' || file.startsWith('dist/'))
      checks.push(
        distFiles.length > 0
          ? passed('pack-dist', `tarball includes ${distFiles.length} dist file(s)`)
          : failed(
            'pack-dist',
            'tarball has no dist/ entries; check package.json "files" includes "dist"',
            files.length === 0 ? 'tarball file list was empty' : files.slice(0, 20).join(', '),
          ),
      )

      checks.push(
        files.includes(CLI_ENTRY)
          ? passed('pack-entry', `tarball includes ${CLI_ENTRY}`)
          : failed(
            'pack-entry',
            `tarball is missing ${CLI_ENTRY}; run "pnpm build" before packing`,
          ),
      )

      const packedProbeAssets = SANDBOX_PROBE_ASSETS.filter(candidate => files.includes(candidate))
      checks.push(
        packedProbeAssets.length === SANDBOX_PROBE_ASSETS.length
          ? passed('pack-probe-assets', `tarball includes ${packedProbeAssets.join(', ')}`)
          : failed(
            'pack-probe-assets',
            'tarball is missing sandbox probe fixtures; run "pnpm build" before packing',
            SANDBOX_PROBE_ASSETS.filter(candidate => !files.includes(candidate)).join(', '),
          ),
      )

      const packedRules = RULES_ASSET_CANDIDATES.filter(candidate => files.includes(candidate))
      checks.push(
        packedRules.length > 0
          ? passed('pack-rules', `tarball includes ${packedRules[0]}`)
          : failed(
            'pack-rules',
            'tarball is missing the runtime rules asset; run "pnpm build" before packing',
            RULES_ASSET_CANDIDATES.join(' or '),
          ),
      )
    }
  } catch (error) {
    checks.push(failed(
      'pack',
      'npm pack --dry-run --json could not run; install npm and retry',
      errorMessage(error),
    ))
  }

  const failures = checks.filter(check => !check.ok)
  return {
    ok: failures.length === 0,
    checks,
    errors: failures.map(check =>
      `${check.message}${check.detail === undefined ? '' : ` (${check.detail})`}`),
  }
}

export function formatReleaseCheck(result: ReleaseCheckResult): string {
  const lines = result.checks.map(check =>
    `${check.ok ? 'ok  ' : 'FAIL'} ${check.message}`
    + (!check.ok && check.detail !== undefined ? `\n     ${check.detail}` : ''))
  const failures = result.checks.filter(check => !check.ok).length
  lines.push('')
  lines.push(result.ok
    ? `release check: ${result.checks.length}/${result.checks.length} check(s) passed`
    : `release check: ${failures}/${result.checks.length} check(s) failed; fix the messages above`)
  return lines.join('\n')
}

function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return pathToFileURL(fs.realpathSync(entry)).href === import.meta.url
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  const result = checkRelease()
  const output = formatReleaseCheck(result)
  if (result.ok) console.log(output)
  else console.error(output)
  process.exitCode = result.ok ? 0 : 1
}

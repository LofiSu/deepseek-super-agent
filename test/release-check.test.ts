import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  checkRelease,
  formatReleaseCheck,
  type ReleaseCheckOptions,
  type ReleaseCheckResult,
} from '../scripts/release-check.ts'

const roots: string[] = []

interface FixtureFiles {
  readonly packageJson?: string | Record<string, unknown>
  readonly files?: Record<string, string>
}

function fixture(options: FixtureFiles = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-release-check-'))
  roots.push(root)
  const packageText = options.packageJson === undefined
    ? JSON.stringify({
      name: 'ds-agent',
      version: '1.2.3',
      bin: { 'ds-agent': './dist/cli/main.js' },
      files: ['dist'],
    })
    : typeof options.packageJson === 'string'
      ? options.packageJson
      : JSON.stringify(options.packageJson)
  fs.writeFileSync(path.join(root, 'package.json'), packageText)

  const files = options.files ?? {
    'dist/cli/main.js': 'console.log("cli")\n',
    'dist/channels/rules.json': '{}\n',
  }
  for (const [file, content] of Object.entries(files)) {
    const absolute = path.join(root, file)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content)
  }
  return root
}

function packOf(paths: readonly string[], options: {
  status?: number
  prefix?: string
  raw?: string
} = {}): NonNullable<ReleaseCheckOptions['pack']> {
  return () => ({
    status: options.status ?? 0,
    stdout: options.raw ?? `${options.prefix ?? ''}${JSON.stringify([
      { id: 'ds-agent@1.2.3', files: paths.map(file => ({ path: file, size: 1 })) },
    ])}`,
    stderr: options.status && options.status !== 0 ? 'pack failed' : '',
  })
}

function check(root: string, paths: readonly string[] = [
  'package.json',
  'dist/cli/main.js',
  'dist/channels/rules.json',
]): ReleaseCheckResult {
  return checkRelease({ root, pack: packOf(paths) })
}

function failed(result: ReleaseCheckResult, id: string): boolean {
  const checkResult = result.checks.find(entry => entry.id === id)
  expect(checkResult, `missing check ${id}`).toBeDefined()
  return checkResult!.ok === false
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('release check', () => {
  it('passes a valid manifest, build tree, and tarball', () => {
    const root = fixture()
    const result = check(root)

    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.checks.map(entry => entry.id)).toEqual([
      'package-json',
      'version',
      'bin',
      'files',
      'dist-entry',
      'dist-rules',
      'pack',
      'pack-dist',
      'pack-entry',
      'pack-rules',
    ])
    expect(formatReleaseCheck(result)).toContain('check(s) passed')
  })

  it('accepts the current dist/watchdog rules asset and JSON after prepack logs', () => {
    const root = fixture({
      files: {
        'dist/cli/main.js': 'console.log("cli")\n',
        'dist/watchdog/rules.json': '{}\n',
      },
    })
    const result = checkRelease({
      root,
      pack: packOf(
        ['dist/cli/main.js', 'dist/watchdog/rules.json'],
        { prefix: 'copied 1 asset(s) to dist\n' },
      ),
    })
    expect(result.ok).toBe(true)
  })

  it('reports a bin target that does not point at dist/cli/main.js', () => {
    const root = fixture({
      packageJson: {
        version: '1.2.3',
        bin: { 'ds-agent': './dist/index.js' },
        files: ['dist'],
      },
    })
    const result = check(root)
    expect(result.ok).toBe(false)
    expect(failed(result, 'bin')).toBe(true)
    expect(result.errors.join('\n')).toMatch(/bin\.ds-agent must be/)
  })

  it('reports a non-semver version', () => {
    const root = fixture({
      packageJson: {
        version: 'v1.2',
        bin: { 'ds-agent': './dist/cli/main.js' },
        files: ['dist'],
      },
    })
    const result = check(root)
    expect(failed(result, 'version')).toBe(true)
    expect(result.errors.join('\n')).toMatch(/semver/)
  })

  it('reports files that do not include dist', () => {
    const root = fixture({
      packageJson: {
        version: '1.2.3',
        bin: { 'ds-agent': './dist/cli/main.js' },
        files: ['README.md'],
      },
    })
    const result = check(root)
    expect(failed(result, 'files')).toBe(true)
    expect(result.errors.join('\n')).toMatch(/"files" must include "dist"/)
  })

  it('reports a missing build entry', () => {
    const root = fixture({ files: { 'dist/channels/rules.json': '{}\n' } })
    const result = check(root)
    expect(failed(result, 'dist-entry')).toBe(true)
    expect(result.errors.join('\n')).toMatch(/pnpm build/)
  })

  it('reports a missing runtime rules asset', () => {
    const root = fixture({ files: { 'dist/cli/main.js': 'console.log("cli")\n' } })
    const result = check(root)
    expect(failed(result, 'dist-rules')).toBe(true)
    expect(result.errors.join('\n')).toMatch(/runtime rules asset missing/)
  })

  it('reports an npm pack failure', () => {
    const root = fixture()
    const result = checkRelease({ root, pack: packOf([], { status: 1 }) })
    expect(failed(result, 'pack')).toBe(true)
    expect(result.errors.join('\n')).toMatch(/npm pack --dry-run --json failed/)
  })

  it('reports a tarball without dist', () => {
    const root = fixture()
    const result = check(root, ['package.json', 'README.md'])
    expect(failed(result, 'pack-dist')).toBe(true)
    expect(result.errors.join('\n')).toMatch(/no dist\/ entries/)
  })

  it('reports a tarball missing the CLI entry or rules asset', () => {
    const root = fixture()
    const result = check(root, ['package.json', 'dist/other.js'])
    expect(failed(result, 'pack-entry')).toBe(true)
    expect(failed(result, 'pack-rules')).toBe(true)
  })

  it('reports unparseable npm pack output', () => {
    const root = fixture()
    const result = checkRelease({ root, pack: packOf([], { raw: 'not json' }) })
    expect(failed(result, 'pack-json')).toBe(true)
  })

  it('reports an unreadable manifest instead of throwing', () => {
    const root = fixture({ packageJson: '{not json' })
    const result = checkRelease({ root, pack: packOf([]) })
    expect(result.ok).toBe(false)
    expect(failed(result, 'package-json')).toBe(true)
  })
})

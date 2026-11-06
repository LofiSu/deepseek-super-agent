import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Run the CLI from source so the unit suite does not need a prior build. */
function runCli(arg: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', arg], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  name: string
  version: string
  license: string
  author: string
  type: string
  engines?: Record<string, string>
  bin?: Record<string, string>
  files?: string[]
  scripts?: Record<string, string>
}
const buildConfig = JSON.parse(readFileSync(path.join(root, 'tsconfig.build.json'), 'utf8')) as {
  extends: string
  compilerOptions: Record<string, boolean | string>
  include: string[]
  exclude: string[]
}

describe('package manifest', () => {
  it('keeps the package identity unchanged', () => {
    expect(pkg.name).toBe('ds-agent')
    expect(pkg.version).toBe('0.1.0')
    expect(pkg.license).toBe('MIT')
    expect(pkg.author).toBe('LofiSu <163713803+LofiSu@users.noreply.github.com>')
    expect(pkg.type).toBe('module')
    expect(pkg.engines?.node).toBe('>=22')
  })

  it('exposes the built CLI as the ds-agent bin', () => {
    expect(pkg.bin).toEqual({ 'ds-agent': './dist/cli/main.js' })
    expect(existsSync(path.join(root, 'src', 'cli', 'main.ts'))).toBe(true)
  })

  it('surfaces the package version on the CLI', () => {
    for (const arg of ['--version', '-V', 'version']) {
      const result = runCli(arg)
      expect(result.status, `${arg}: ${result.stderr}`).toBe(0)
      expect(result.stdout.trim(), arg).toBe(pkg.version)
      expect(result.stderr, arg).toBe('')
    }
  })

  it('lists the version flags in --help', () => {
    const result = runCli('--help')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('--version')
    expect(result.stdout).toContain('-V')
  })

  it('builds dist through the build tsconfig and on prepack', () => {
    expect(pkg.scripts?.build).toBe('tsc -p tsconfig.build.json && tsx scripts/copy-assets.ts')
    expect(pkg.scripts?.prepack).toBe('pnpm build')
  })

  it('ships only dist plus the user-facing license and docs', () => {
    expect(pkg.files).toEqual([
      'dist',
      'README.md',
      'README.zh-CN.md',
      'LICENSE',
      'docs/MODULES.md',
      'docs/REAL_CHANNELS.md',
    ])
    // dist is build output and must stay untracked; the unit suite runs
    // without a build, so only the checked-in files are required to exist.
    const gitignore = readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n')
    expect(gitignore).toContain('dist')
    for (const file of (pkg.files ?? []).filter(entry => entry !== 'dist')) {
      expect(existsSync(path.join(root, file)), file).toBe(true)
    }
  })
})

describe('tsconfig.build.json', () => {
  it('extends the base config and emits ESM to dist', () => {
    expect(buildConfig.extends).toBe('./tsconfig.json')
    expect(buildConfig.compilerOptions.noEmit).toBe(false)
    expect(buildConfig.compilerOptions.outDir).toBe('dist')
    expect(buildConfig.compilerOptions.rootDir).toBe('src')
    expect(buildConfig.compilerOptions.module).toBe('NodeNext')
    expect(buildConfig.compilerOptions.moduleResolution).toBe('NodeNext')
    expect(buildConfig.compilerOptions.declaration).toBe(false)
    expect(buildConfig.compilerOptions.sourceMap).toBe(false)
  })

  it('rewrites source .ts imports to .js in the emitted tree', () => {
    expect(buildConfig.compilerOptions.rewriteRelativeImportExtensions).toBe(true)
    expect(buildConfig.compilerOptions.allowImportingTsExtensions).toBe(false)
  })

  it('compiles src only', () => {
    expect(buildConfig.include).toEqual(['src/**/*.ts'])
    expect(buildConfig.exclude).toEqual(expect.arrayContaining(['test', 'scripts', 'vitest.config.ts']))
  })

  it('declares dist as the emitted output', () => {
    expect(buildConfig.compilerOptions.outDir).toBe('dist')
    expect(pkg.files).toContain(buildConfig.compilerOptions.outDir)
  })
})

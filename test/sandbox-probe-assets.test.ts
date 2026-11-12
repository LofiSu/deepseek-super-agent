/**
 * The published sandbox probe must load its host-side fixtures from beside the
 * compiled module. A repo-root `test/fixtures` path works only when the source
 * checkout is present and silently degrades to `probe_failed` after an 8s stall
 * in an installed package.
 *
 * These checks exercise the real probe module from a stripped layout that has
 * no `test/` directory, then prove a missing fixture fails fast.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { RUNTIME_ASSETS } from '../scripts/copy-assets.ts'
import { sandboxProbeFixturePaths } from '../src/env/sandbox-probe.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const LAYOUT_FILES = [
  'src/env/sandbox-probe.ts',
  'src/env/seccomp.ts',
  'src/shared/errors.ts',
  'src/env/fixtures/sandbox-loopback-server.mjs',
  'src/env/fixtures/sandbox-external-pid-fixture.mjs',
] as const

const PROBE_SCRIPT = `
import { existsSync } from 'node:fs'
import { probeSandboxConfinement, sandboxProbeFixturePaths } from './src/env/sandbox-probe.ts'

const paths = sandboxProbeFixturePaths()
const fake = (status) => ({ status, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null, error: undefined })
const started = Date.now()
const probe = probeSandboxConfinement(
  { platform: 'linux', available: () => true, exists: () => true, execPath: process.execPath },
  {
    runWrapped: (command, policy) => {
      if (command === 'true') return fake(0)
      if (command.includes('echo ok')) return fake(0)
      if (command.includes('ds-agent-sandbox-negative-probe')) return fake(0)
      if (command.includes('test -r')) return fake(1)
      if (command.includes('fetch(')) return fake(policy.allowNetwork === true ? 0 : 1)
      if (command === 'kill -0 $$') return fake(0)
      if (command.includes('kill -0')) return fake(1)
      return fake(0)
    },
    runUnsandboxed: () => fake(0),
  },
  { enabled: true, readIsolation: true, unsharePid: true },
)
process.stdout.write(JSON.stringify({
  present: { loopback: existsSync(paths.loopback), externalPid: existsSync(paths.externalPid) },
  loopbackPath: paths.loopback,
  dimensions: probe.dimensions,
  elapsedMs: Date.now() - started,
}))
`

interface LayoutProbe {
  present: { loopback: boolean; externalPid: boolean }
  loopbackPath: string
  dimensions: Record<string, string>
  elapsedMs: number
}

const roots: string[] = []

function makeLayout(withFixtures: boolean): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ds-agent-probe-layout-'))
  roots.push(dir)
  for (const file of LAYOUT_FILES) {
    if (!withFixtures && file.includes('/fixtures/')) continue
    const destination = path.join(dir, file)
    mkdirSync(path.dirname(destination), { recursive: true })
    copyFileSync(path.join(root, file), destination)
  }
  writeFileSync(path.join(dir, 'run-probe.mjs'), PROBE_SCRIPT, 'utf8')
  return dir
}

function runLayout(dir: string): LayoutProbe {
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(dir, 'run-probe.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })
  expect(result.status, result.stderr || result.stdout).toBe(0)
  return JSON.parse(result.stdout) as LayoutProbe
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('sandbox probe fixture packaging', () => {
  it('resolves probe fixtures beside the module, not in the repo test tree', () => {
    const fixtures = sandboxProbeFixturePaths()
    const expectedDir = path.join(root, 'src', 'env', 'fixtures') + path.sep
    for (const file of [fixtures.loopback, fixtures.externalPid]) {
      expect(file.startsWith(expectedDir), file).toBe(true)
      expect(existsSync(file), file).toBe(true)
    }
    expect(existsSync(path.join(root, 'test', 'fixtures', 'sandbox-loopback-server.mjs'))).toBe(false)
    expect(existsSync(path.join(root, 'test', 'fixtures', 'sandbox-external-pid-fixture.mjs'))).toBe(false)
  })

  it('lists both fixtures as runtime assets copied into dist', () => {
    expect(RUNTIME_ASSETS).toContain('env/fixtures/sandbox-loopback-server.mjs')
    expect(RUNTIME_ASSETS).toContain('env/fixtures/sandbox-external-pid-fixture.mjs')
  })

  it('runs the probe from a layout with no test/ directory', () => {
    const dir = makeLayout(true)
    expect(existsSync(path.join(dir, 'test'))).toBe(false)
    const result = runLayout(dir)
    expect(result.present).toEqual({ loopback: true, externalPid: true })
    expect(result.loopbackPath.startsWith(path.join(dir, 'src', 'env', 'fixtures') + path.sep)).toBe(true)
    expect(result.dimensions.network).toBe('enforced')
    expect(result.dimensions.process).toBe('enforced')
  })

  it('fails fast when a fixture is missing instead of polling the full deadline', () => {
    const result = runLayout(makeLayout(false))
    expect(result.present).toEqual({ loopback: false, externalPid: false })
    expect(result.dimensions.network).toBe('probe_failed')
    expect(result.dimensions.process).toBe('probe_failed')
    // Old behavior polled for 8s per dimension before returning probe_failed.
    expect(result.elapsedMs).toBeLessThan(3_000)
  })
})

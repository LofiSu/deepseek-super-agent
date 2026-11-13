import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  assertRequiredSandboxDimensions,
  probeSandboxConfinement,
  probeSandboxWrapper,
  type SandboxConfinementProbeHooks,
} from '../src/env/sandbox-probe.ts'
import { wrapBashCommand, type SandboxPolicy, type SandboxSystem } from '../src/env/seccomp.ts'
import { UserError } from '../src/shared/errors.ts'

const linuxBwrapSystem = (): SandboxSystem => ({
  platform: 'linux',
  available: bin => bin === 'bwrap',
  exists: () => true,
  execPath: '/usr/bin/node',
})

const fakeResult = (status: number): SpawnSyncReturns<string> => ({
  status,
  stdout: '',
  stderr: '',
  pid: 0,
  output: [null, '', ''],
  signal: null,
  error: undefined,
})

const realBash = (command: string): SpawnSyncReturns<string> =>
  spawnSync('bash', ['--noprofile', '--norc', '-c', command], { encoding: 'utf8' })

/** Wrapped hooks where write is blocked and only the read result varies. */
function readIsolationHooks(
  wrappedReadStatus: number,
  runUnsandboxed: (command: string) => SpawnSyncReturns<string>,
): SandboxConfinementProbeHooks {
  return {
    runWrapped: command => {
      if (command === 'true') return fakeResult(0)
      if (command.includes('echo ok')) return fakeResult(0)
      if (command.includes('ds-agent-sandbox-negative-probe')) return fakeResult(0)
      if (command.includes('test -r') && command.includes('probe-write.txt')) return fakeResult(wrappedReadStatus)
      if (command.includes('fetch(')) return fakeResult(1)
      if (command.includes('kill -0')) return fakeResult(command.includes('PPID') ? 1 : 0)
      return fakeResult(0)
    },
    runUnsandboxed,
    loopbackPort: 19_879,
  }
}

const strictReadPolicy: SandboxPolicy = { enabled: true, readIsolation: true }

describe('sandbox wrapper probe (PATH ≠ enforcement)', () => {
  it('fails closed when wrapper is unavailable on Linux', () => {
    const system: SandboxSystem = { platform: 'linux', available: () => false }
    expect(() => wrapBashCommand('true', { enabled: true }, system)).toThrow(UserError)
    const probe = probeSandboxWrapper(system)
    expect(probe.wrapper).toBeNull()
    expect(probe.canWrap).toBe(false)
    const confinement = probeSandboxConfinement(system)
    expect(confinement.outcome).toBe('unsupported')
  })

  it('builds wrapped argv when bwrap is available (positive)', () => {
    const system = linuxBwrapSystem()
    const probe = probeSandboxWrapper(system)
    expect(probe.wrapper).toBe('bwrap')
    expect(probe.canWrap).toBe(true)
  })

  it('fake unconfined wrapper yields not_enforced, not enforced', () => {
    const system = linuxBwrapSystem()
    const hooks: SandboxConfinementProbeHooks = {
      runWrapped: (command) => {
        // Deliberately ignore the wrapper argv and run unsandboxed bash.
        return spawnSync('bash', ['--noprofile', '--norc', '-c', command], { encoding: 'utf8' })
      },
      runUnsandboxed: (command) => spawnSync('bash', ['--noprofile', '--norc', '-c', command], { encoding: 'utf8' }),
    }
    const confinement = probeSandboxConfinement(system, hooks)
    expect(confinement.positiveExecOk).toBe(true)
    expect(confinement.unconfinedForbiddenWriteOk).toBe(true)
    expect(confinement.outcome).toBe('not_enforced')
    expect(confinement.dimensions.write).toBe('not_enforced')
    expect(confinement.negativeWriteBlocked).toBe(false)
  })

  it('failed wrapped exec is probe_failed, not enforcement', () => {
    const system = linuxBwrapSystem()
    const hooks: SandboxConfinementProbeHooks = {
      runWrapped: () => ({ status: 1, stdout: '', stderr: 'boom', pid: 0, output: [null, '', 'boom'], signal: null, error: undefined }),
      runUnsandboxed: (command) => spawnSync('bash', ['--noprofile', '--norc', '-c', command], { encoding: 'utf8' }),
    }
    const confinement = probeSandboxConfinement(system, hooks)
    expect(confinement.outcome).toBe('probe_failed')
    expect(confinement.dimensions.write).toBe('probe_failed')
    expect(confinement.negativeWriteBlocked).toBeNull()
  })

  it('on-host optional smoke: run wrapped true when wrapper exists', () => {
    const system: SandboxSystem = {
      platform: process.platform,
      available: bin => spawnSync('which', [bin], { stdio: 'ignore' }).status === 0,
      exists: () => true,
      execPath: process.execPath,
    }
    const probe = probeSandboxWrapper(system)
    if (!probe.canWrap) {
      expect(probe.wrapper).toBeNull()
      return
    }
    const argv = wrapBashCommand('true', { enabled: true, writableRoots: [process.cwd()] }, system).argv
    const result = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 15_000 })
    expect(result.status, result.stderr).toBe(0)
  })

  it('cloud host runtime sandbox probe (non-gating)', () => {
    if (!process.env.DS_AGENT_CLOUD_SANDBOX_PROBE) return
    const confinement = probeSandboxConfinement()
    expect(['enforced', 'not_enforced', 'probe_failed', 'unsupported']).toContain(confinement.outcome)
    if (confinement.outcome !== 'unsupported') {
      expect(confinement.positiveExecOk).toBe(true)
      expect(confinement.positiveWriteOk).toBe(true)
    }
  })

  it('on-host confinement smoke when wrapper exists', () => {
    const system: SandboxSystem = {
      platform: process.platform,
      available: bin => spawnSync('which', [bin], { stdio: 'ignore' }).status === 0,
      exists: () => true,
      execPath: process.execPath,
    }
    const confinement = probeSandboxConfinement(system)
    if (confinement.outcome === 'unsupported') return
    expect(confinement.positiveExecOk).toBe(true)
    expect(confinement.positiveWriteOk).toBe(true)
    expect(confinement.unconfinedForbiddenWriteOk).toBe(true)
    expect(confinement.negativeWriteBlocked).not.toBeNull()
    for (const dim of ['read', 'network', 'process'] as const) {
      expect(['enforced', 'not_enforced', 'unsupported', 'probe_failed', 'not_tested']).toContain(confinement.dimensions[dim])
    }
    expect(['enforced', 'not_enforced', 'probe_failed']).toContain(confinement.outcome)
  })
})

describe('sandbox read isolation requires a readable canary', () => {
  it('does not claim enforced read isolation when the unsandboxed positive control cannot read the canary', () => {
    const denyReadControl = (command: string): SpawnSyncReturns<string> => {
      if (command.includes('test -r') && command.includes('probe-write.txt')) return fakeResult(1)
      return realBash(command)
    }
    const probe = probeSandboxConfinement(
      linuxBwrapSystem(),
      readIsolationHooks(1, denyReadControl),
      strictReadPolicy,
    )
    expect(probe.dimensions.write).toBe('enforced')
    expect(probe.dimensions.read).toBe('probe_failed')
  })

  it('reports enforced read isolation when the canary is readable unsandboxed and hidden when wrapped', () => {
    const probe = probeSandboxConfinement(
      linuxBwrapSystem(),
      readIsolationHooks(1, realBash),
      strictReadPolicy,
    )
    expect(probe.dimensions.write).toBe('enforced')
    expect(probe.dimensions.read).toBe('enforced')
    expect(() =>
      assertRequiredSandboxDimensions(probe, { DS_AGENT_SANDBOX_REQUIRED: 'read' }, strictReadPolicy),
    ).not.toThrow()
  })

  it('reports not_enforced when the wrapped read succeeds', () => {
    const probe = probeSandboxConfinement(
      linuxBwrapSystem(),
      readIsolationHooks(0, realBash),
      strictReadPolicy,
    )
    expect(probe.dimensions.write).toBe('enforced')
    expect(probe.dimensions.read).toBe('not_enforced')
  })
})

describe('sandbox probe requires the forbidden parent to be visible', () => {
  type VisibilityMode = 'write' | 'read'

  /**
   * A wrapper that never binds `os.tmpdir()` (as `linuxStrictArgv` does for a
   * TMPDIR outside `/tmp`) leaves the forbidden sibling directory out of the
   * namespace. These hooks run the official probe commands under real bash but
   * remove that directory first, so the redirect fails because the parent is
   * absent, not because a write was denied.
   */
  function invisibleParentHooks(mode: VisibilityMode): SandboxConfinementProbeHooks {
    let forbiddenDir: string | undefined
    const recallForbiddenDir = (command: string): string | undefined => {
      const match = /'([^']*[/\\]forbidden[/\\]probe-write\.txt)'/.exec(command)
      if (match) forbiddenDir = dirname(match[1]!)
      return forbiddenDir
    }
    const hideForbiddenDir = (command: string): void => {
      const dir = recallForbiddenDir(command)
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    }
    return {
      runWrapped: (command, policy) => {
        if (command.includes('ds-agent-sandbox-negative-probe')) {
          recallForbiddenDir(command)
          // Keep the write dimension enforced so the read path is tested alone.
          if (mode === 'read') return fakeResult(0)
          hideForbiddenDir(command)
          return realBash(command)
        }
        if (command.includes('test -d') || command.includes('test -r')) {
          hideForbiddenDir(command)
          return realBash(command)
        }
        if (command.includes('fetch(')) return fakeResult(policy.allowNetwork === true ? 0 : 1)
        return realBash(command)
      },
      runUnsandboxed: realBash,
      loopbackPort: 19_881,
    }
  }

  it('write is probe_failed, never enforced, when the forbidden directory is not mounted', () => {
    const probe = probeSandboxConfinement(
      linuxBwrapSystem(),
      invisibleParentHooks('write'),
      { enabled: true },
    )
    expect(probe.positiveExecOk).toBe(true)
    expect(probe.positiveWriteOk).toBe(true)
    expect(probe.dimensions.write).toBe('probe_failed')
    expect(probe.dimensions.write).not.toBe('enforced')
    expect(probe.negativeWriteBlocked).toBe(false)
    expect(probe.outcome).toBe('probe_failed')
    expect(() => assertRequiredSandboxDimensions(probe, {})).toThrow(UserError)
  })

  it('read is probe_failed, never enforced, when the canary directory is not mounted', () => {
    const probe = probeSandboxConfinement(
      linuxBwrapSystem(),
      invisibleParentHooks('read'),
      strictReadPolicy,
    )
    expect(probe.dimensions.write).toBe('enforced')
    expect(probe.dimensions.read).toBe('probe_failed')
    expect(probe.dimensions.read).not.toBe('enforced')
  })
})

const REAL_LINUX_BWRAP = process.platform === 'linux'
  && spawnSync('which', ['bwrap'], { stdio: 'ignore' }).status === 0

const SOURCE_PROBE_MODULE = fileURLToPath(new URL('../src/env/sandbox-probe.ts', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * On-host companion to the hook-based regressions: run the real probe with
 * `TMPDIR` outside `/tmp`, where strict bwrap binds only `/tmp` read-only and
 * therefore never mounts the probe tree. A child process sets `TMPDIR` before
 * `os.tmpdir()` is first read, matching the verified defect.
 */
describe.skipIf(!REAL_LINUX_BWRAP)('sandbox probe with TMPDIR outside /tmp (on host)', () => {
  it('reports probe_failed for write and read instead of enforced', () => {
    let outside: string
    try {
      outside = mkdtempSync(join(homedir(), '.ds-agent-tmpdir-outside-'))
    } catch {
      return // no writable location outside /tmp on this host
    }
    try {
      const script = join(outside, 'run-probe.mjs')
      writeFileSync(
        script,
        `import { probeSandboxConfinement } from ${JSON.stringify(SOURCE_PROBE_MODULE)}
const probe = probeSandboxConfinement(undefined, {}, { enabled: true, readIsolation: true, allowNetwork: true })
process.stdout.write(JSON.stringify({
  write: probe.dimensions.write,
  read: probe.dimensions.read,
  outcome: probe.outcome,
  positiveExecOk: probe.positiveExecOk,
  positiveWriteOk: probe.positiveWriteOk,
}))
`,
        'utf8',
      )
      const result = spawnSync(process.execPath, ['--import', 'tsx', script], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, TMPDIR: outside, NODE_NO_WARNINGS: '1' },
      })
      expect(result.status, result.stderr || result.stdout).toBe(0)
      const parsed = JSON.parse(result.stdout) as {
        write: string
        read: string
        outcome: string
        positiveExecOk: boolean
        positiveWriteOk: boolean
      }
      expect(parsed.positiveExecOk).toBe(true)
      expect(parsed.positiveWriteOk).toBe(true)
      expect(parsed.write).toBe('probe_failed')
      expect(parsed.read).toBe('probe_failed')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

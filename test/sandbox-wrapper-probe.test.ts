import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  probeSandboxConfinement,
  probeSandboxWrapper,
  type SandboxConfinementProbeHooks,
} from '../src/env/sandbox-probe.ts'
import { wrapBashCommand, type SandboxSystem } from '../src/env/seccomp.ts'
import { UserError } from '../src/shared/errors.ts'

const linuxBwrapSystem = (): SandboxSystem => ({
  platform: 'linux',
  available: bin => bin === 'bwrap',
  exists: () => true,
  execPath: '/usr/bin/node',
})

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
      expect(['enforced', 'not_enforced', 'unsupported', 'probe_failed']).toContain(confinement.dimensions[dim])
    }
    expect(['enforced', 'not_enforced', 'probe_failed']).toContain(confinement.outcome)
  })
})

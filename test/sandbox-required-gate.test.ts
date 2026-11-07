import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { LocalEnv } from '../src/env/local-env.ts'
import { UserError } from '../src/shared/errors.ts'
import {
  assertRequiredSandboxDimensions,
  probeSandboxConfinement,
  type SandboxConfinementProbe,
  type SandboxConfinementProbeHooks,
} from '../src/env/sandbox-probe.ts'
import type { SandboxSystem } from '../src/env/seccomp.ts'
import { tempHome } from './fixtures.ts'

const linuxBwrapSystem = (): SandboxSystem => ({
  platform: 'linux',
  available: bin => bin === 'bwrap',
  exists: () => true,
  execPath: '/usr/bin/node',
})

function fakeEnforced(hooks?: Partial<SandboxConfinementProbeHooks>): SandboxConfinementProbe {
  const system = linuxBwrapSystem()
  return probeSandboxConfinement(system, {
    runWrapped: command => {
      if (command.includes('probe-write.txt') && command.includes('ds-agent-sandbox-negative-probe')) {
        return { status: 0, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null, error: undefined }
      }
      if (command.includes('echo ok')) {
        return { status: 0, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null, error: undefined }
      }
      if (command.includes('fetch(')) {
        return { status: 1, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null, error: undefined }
      }
      if (command.includes('kill -0')) {
        if (command.includes('PPID')) return { status: 1, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null, error: undefined }
        return { status: 0, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null, error: undefined }
      }
      return { status: 0, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null, error: undefined }
    },
    runUnsandboxed: command => spawnSync('bash', ['--noprofile', '--norc', '-c', command], { encoding: 'utf8' }),
    loopbackPort: 9_876,
    ...hooks,
  })
}

describe('required sandbox dimensions gate', () => {
  it('rejects default required write when fake unconfined wrapper yields not_enforced', () => {
    const system = linuxBwrapSystem()
    const hooks: SandboxConfinementProbeHooks = {
      runWrapped: command => spawnSync('bash', ['--noprofile', '--norc', '-c', command], { encoding: 'utf8' }),
      runUnsandboxed: command => spawnSync('bash', ['--noprofile', '--norc', '-c', command], { encoding: 'utf8' }),
      loopbackPort: 19_877,
    }
    const probe = probeSandboxConfinement(system, hooks)
    expect(probe.dimensions.write).toBe('not_enforced')
    expect(probe.outcome).toBe('not_enforced')
    expect(() => assertRequiredSandboxDimensions(probe, {})).toThrow(UserError)
  })

  it('rejects when required write is explicitly listed but status is not_enforced', () => {
    const probe = fakeEnforced({
      runWrapped: command => spawnSync('bash', ['--noprofile', '--norc', '-c', command], { encoding: 'utf8' }),
    })
    expect(probe.dimensions.write).toBe('not_enforced')
    expect(() => assertRequiredSandboxDimensions(probe, { DS_AGENT_SANDBOX_REQUIRED: 'write' })).toThrow(UserError)
  })

  it('rejects when required process is not_enforced', () => {
    const probe = probeSandboxConfinement(linuxBwrapSystem(), {
      runWrapped: (command) => {
        if (command.includes('probe-write.txt')) {
          return { status: 0, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null, error: undefined }
        }
        if (command.includes('echo ok') || command === 'true') {
          return { status: 0, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null, error: undefined }
        }
        if (command.includes('fetch(')) {
          return { status: command.includes('127.0.0.1') ? 0 : 1, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null, error: undefined }
        }
        if (command.includes('$PPID')) {
          return { status: 0, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null, error: undefined }
        }
        if (command.includes('kill -0')) {
          return { status: 0, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null, error: undefined }
        }
        return { status: 0, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null, error: undefined }
      },
      runUnsandboxed: command => spawnSync('bash', ['--noprofile', '--norc', '-c', command], { encoding: 'utf8' }),
      loopbackPort: 19_876,
    })
    expect(probe.dimensions.process).toBe('not_enforced')
    expect(() =>
      assertRequiredSandboxDimensions(probe, { DS_AGENT_SANDBOX_REQUIRED: 'process' }),
    ).toThrow(UserError)
  })

  it('LocalEnv fails closed when DS_AGENT_SANDBOX_REQUIRED includes process and probe is not enforced', () => {
    const home = tempHome()
    const prev = process.env.DS_AGENT_SANDBOX_REQUIRED
    process.env.DS_AGENT_SANDBOX_REQUIRED = 'process'
    try {
      expect(() => new LocalEnv(home)).toThrow(UserError)
    } finally {
      if (prev === undefined) delete process.env.DS_AGENT_SANDBOX_REQUIRED
      else process.env.DS_AGENT_SANDBOX_REQUIRED = prev
    }
  })

  it('passes assert when default write dimension is enforced', () => {
    const probe = fakeEnforced()
    probe.dimensions.write = 'enforced'
    probe.outcome = 'enforced'
    probe.dimensions.process = 'not_enforced'
    expect(() => assertRequiredSandboxDimensions(probe, {})).not.toThrow()
  })
})

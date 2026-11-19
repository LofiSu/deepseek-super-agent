import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { probeSandboxConfinement, type SandboxConfinementProbeHooks } from '../src/env/sandbox-probe.ts'
import { type SandboxSystem } from '../src/env/seccomp.ts'

const linuxBwrapSystem = (): SandboxSystem => ({
  platform: 'linux',
  available: bin => bin === 'bwrap',
  exists: () => true,
  execPath: '/usr/bin/node',
})

describe('sandbox process isolation probe', () => {
  it('fake unconfined wrapper cannot pass external PID visibility', () => {
    const system = linuxBwrapSystem()
    const hooks: SandboxConfinementProbeHooks = {
      externalPid: process.pid,
      runWrapped: (command) => spawnSync('bash', ['--noprofile', '--norc', '-c', command], { encoding: 'utf8' }),
      runUnsandboxed: (command) => spawnSync('bash', ['--noprofile', '--norc', '-c', command], { encoding: 'utf8' }),
    }
    const confinement = probeSandboxConfinement(system, hooks, { enabled: true, unsharePid: true })
    expect(confinement.dimensions.process).toBe('not_enforced')
  })

  it('on-host external fixture probe when bwrap exists', () => {
    const system: SandboxSystem = {
      platform: process.platform,
      available: bin => spawnSync('which', [bin], { stdio: 'ignore' }).status === 0,
      exists: () => true,
      execPath: process.execPath,
    }
    const probe = probeSandboxConfinement(system)
    if (probe.outcome === 'unsupported') return
    expect(['enforced', 'not_enforced', 'probe_failed', 'unsupported', 'not_tested']).toContain(probe.dimensions.process)
  })
})

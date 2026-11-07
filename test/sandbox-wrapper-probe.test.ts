import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { probeSandboxWrapper } from '../src/env/sandbox-probe.ts'
import { wrapBashCommand, type SandboxSystem } from '../src/env/seccomp.ts'
import { UserError } from '../src/shared/errors.ts'

describe('sandbox wrapper probe (PATH ≠ enforcement)', () => {
  it('fails closed when wrapper is unavailable on Linux', () => {
    const system: SandboxSystem = { platform: 'linux', available: () => false }
    expect(() => wrapBashCommand('true', { enabled: true }, system)).toThrow(UserError)
    const probe = probeSandboxWrapper(system)
    expect(probe.wrapper).toBeNull()
    expect(probe.canWrap).toBe(false)
  })

  it('builds wrapped argv when bwrap is available (positive)', () => {
    const system: SandboxSystem = {
      platform: 'linux',
      available: bin => bin === 'bwrap',
      exists: () => true,
    }
    const probe = probeSandboxWrapper(system)
    expect(probe.wrapper).toBe('bwrap')
    expect(probe.canWrap).toBe(true)
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
})

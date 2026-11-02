import { describe, expect, it } from 'vitest'
import { LocalEnv } from '../src/env/local-env.ts'
import { FileVault, MemoryVault } from '../src/env/vault.ts'
import { wrapBashCommand } from '../src/env/seccomp.ts'
import { assertStoreEnvSeparation } from '../src/shared/boundary.ts'
import { tempHome } from './fixtures.ts'
import fs from 'node:fs'
import path from 'node:path'

describe('T51 vault + Store/Env boundary', () => {
  it('injects vault secrets into child env but redacts them from stdout', async () => {
    const home = tempHome()
    const vault = new MemoryVault()
    vault.set('MY_TOKEN', 'super-secret-token-value')
    const env = new LocalEnv(home, {
      vault,
      vaultNames: ['MY_TOKEN'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      allowlist: ['PATH', 'HOME'],
      sandbox: { enabled: false },
    })
    const result = await env.bash('w1', 'echo "token=$MY_TOKEN"')
    expect(result.stdout).not.toContain('super-secret-token-value')
    expect(result.stdout).toContain('[redacted]')
    // names are listable; values are not exposed via Vault API for prompts
    expect(vault.names()).toEqual(['MY_TOKEN'])
    expect(vault.has('MY_TOKEN')).toBe(true)
  })

  it('wrapBashCommand uses sandbox-exec on Darwin when enabled', () => {
    // Stub the platform: a Linux CI runner must not decide this assertion.
    const wrapped = wrapBashCommand(
      'echo hi',
      { enabled: true, allowNetwork: false },
      { platform: 'darwin', available: () => true },
    )
    expect(wrapped.wrapped).toBe(true)
    expect(wrapped.argv[0]).toBe('sandbox-exec')
    expect(wrapped.argv.join(' ')).toContain('(deny network*)')
  })

  it('uses available Linux no-network wrapper and falls back when none exists', () => {
    const policy = { enabled: true, allowNetwork: false }
    expect(wrapBashCommand('echo hi', policy, { platform: 'linux', available: bin => bin === 'bwrap' }).argv)
      .toContain('--unshare-net')
    expect(wrapBashCommand('echo hi', policy, { platform: 'linux', available: bin => bin === 'unshare' }).argv)
      .toEqual(['unshare', '--net', '--', 'bash', '-c', 'echo hi'])
    expect(wrapBashCommand('echo hi', policy, { platform: 'linux', available: () => false }).wrapped)
      .toBe(false)
  })

  it('enforces Store/Env boundary', () => {
    const env = new LocalEnv(tempHome(), { sandbox: { enabled: false } })
    expect(() => assertStoreEnvSeparation(env)).not.toThrow()
  })

  it('describes presence without serializing secret values', () => {
    const file = path.join(tempHome(), 'vault.json')
    const vault = new FileVault(file)
    vault.set('TOKEN', 'never-print-this-value')
    expect(vault.describe()).toEqual([{ name: 'TOKEN', present: true }])
    expect(JSON.stringify({ vault, metadata: vault.describe() })).not.toContain('never-print-this-value')
    expect(vault.resolveForChild(['TOKEN']).TOKEN).toBe('never-print-this-value')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })
})

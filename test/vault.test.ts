import { describe, expect, it } from 'vitest'
import { LocalEnv } from '../src/env/local-env.ts'
import { MemoryVault } from '../src/env/vault.ts'
import { wrapBashCommand } from '../src/env/seccomp.ts'
import { assertStoreEnvSeparation } from '../src/shared/boundary.ts'
import { tempHome } from './fixtures.ts'

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
    const wrapped = wrapBashCommand('echo hi', { enabled: true, allowNetwork: false })
    if (process.platform === 'darwin') {
      expect(wrapped.wrapped).toBe(true)
      expect(wrapped.argv[0]).toBe('sandbox-exec')
    } else {
      expect(wrapped.argv[0]).toBe('bash')
    }
  })

  it('enforces Store/Env boundary', () => {
    const env = new LocalEnv(tempHome(), { sandbox: { enabled: false } })
    expect(() => assertStoreEnvSeparation(env)).not.toThrow()
  })
})

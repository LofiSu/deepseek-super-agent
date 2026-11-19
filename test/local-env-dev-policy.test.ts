import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalEnv } from '../src/env/local-env.ts'
import { UserError } from '../src/shared/errors.ts'
import { tempHome } from './fixtures.ts'

/** Policy and env run before spawn; sandbox off is enough. */
function policyEnv(root: string): LocalEnv {
  return new LocalEnv(root, { timeoutMs: 10_000, sandbox: { enabled: false } })
}

describe('LocalEnv dev policy and GIT_SSH_COMMAND', () => {
  it('rejects git push origin on current branch main before spawn', async () => {
    const root = tempHome()
    const env = policyEnv(root)
    const ws = env.workspace('main-push')
    execSync('git init -b main', {
      cwd: ws,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    })
    execSync('git config user.email t@t.com && git config user.name t', { cwd: ws })
    execSync('echo x > f && git add f && git commit -m c', { cwd: ws })
    await expect(env.bash('main-push', 'git push origin')).rejects.toThrow(UserError)
  })

  it('GIT_SSH_COMMAND uses /dev/null config and no missing workspace config path', async () => {
    const env = policyEnv(tempHome())
    const result = await env.bash('ssh-env', 'echo "$GIT_SSH_COMMAND"')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('-F /dev/null')
    expect(result.stdout).not.toMatch(/\.ssh\/config/)
    expect(result.stdout).toContain('IdentitiesOnly=yes')
    expect(result.stdout).toContain('AddKeysToAgent=no')
  })

  it('GIT_SSH_COMMAND adds IdentityFile only for keys that exist under workspace .ssh', async () => {
    const root = tempHome()
    const env = policyEnv(root)
    const ws = env.workspace('keys')
    const sshDir = path.join(ws, '.ssh')
    fs.mkdirSync(sshDir, { mode: 0o700 })
    fs.writeFileSync(path.join(sshDir, 'id_ed25519'), 'not-a-real-key')
    const result = await env.bash('keys', 'echo "$GIT_SSH_COMMAND"')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`IdentityFile=${path.join(sshDir, 'id_ed25519')}`)
    expect(result.stdout).not.toContain('id_rsa')
  })
})

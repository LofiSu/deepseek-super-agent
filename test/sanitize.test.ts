import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Engine } from '../src/core/engine.ts'
import { LocalEnv } from '../src/env/local-env.ts'
import { allowlistedEnv, isSecretEnvName, redactSecrets, secretValues } from '../src/env/sanitize.ts'
import { ToolRegistry } from '../src/harness/tools.ts'
import type { Store } from '../src/store/sqlite.ts'

const secret = 'sk-regression-key-9f3a7c'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-env-'))
  dirs.push(root)
  return root
}

function envWithKey(root: string): LocalEnv {
  return new LocalEnv(root, {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DS_AGENT_API_KEY: secret,
      AWS_SECRET_ACCESS_KEY: `${secret}-aws`,
      FOO_LEAK: 'should-not-pass',
    },
    allowlist: ['PATH', 'HOME', 'DS_AGENT_API_KEY'],
  })
}

describe('API key redaction', () => {
  it('drops secret names from the allowlist and redacts their values', () => {
    expect(isSecretEnvName('DS_AGENT_API_KEY')).toBe(true)
    expect(isSecretEnvName('OPENAI_API_KEY')).toBe(true)
    expect(isSecretEnvName('GITHUB_TOKEN')).toBe(true)
    expect(isSecretEnvName('PATH')).toBe(false)
    expect(secretValues({
      PATH: '/usr/bin',
      DS_AGENT_API_KEY: 'short',
      GITHUB_TOKEN: 'ghp_example_token_value',
    })).toEqual(['ghp_example_token_value'])
    expect(allowlistedEnv(
      { PATH: '/usr/bin', DS_AGENT_API_KEY: secret, FOO: '1' },
      ['PATH', 'DS_AGENT_API_KEY', 'FOO'],
    )).toEqual({ PATH: '/usr/bin', FOO: '1' })
    expect(redactSecrets(`a ${secret} b ${secret}`, [secret])).toBe('a [redacted] b [redacted]')
  })

  it('does not return API key values from bash stdout or stderr', async () => {
    const env = envWithKey(workspace())
    const expanded = await env.bash('w1', 'echo KEY=$DS_AGENT_API_KEY; printenv')
    expect(expanded.code).toBe(0)
    expect(expanded.stdout).toContain('KEY=')
    expect(expanded.stdout).toContain('PATH=')
    expect(expanded.stdout).not.toContain(secret)
    expect(expanded.stdout).not.toContain('DS_AGENT_API_KEY')
    expect(expanded.stdout).not.toContain('should-not-pass')
    expect(expanded.stderr).not.toContain(secret)

    await env.writeFile('w1', 'leak.txt', `token=${secret}\naws=${secret}-aws\n`)
    expect(fs.readFileSync(path.join(dirs[0]!, 'w1', 'leak.txt'), 'utf8')).toContain(secret)
    const read = await env.readFile('w1', 'leak.txt')
    expect(read).not.toContain(secret)
    expect(read).toContain('[redacted]')

    const cat = await env.bash('w1', 'cat leak.txt')
    expect(cat.stdout).not.toContain(secret)
    const echoed = await env.bash('w1', `printf '%s\\n' '${secret}' '${secret}-aws' >&2`)
    expect(echoed.stdout).not.toContain(secret)
    expect(echoed.stderr).not.toContain(secret)
    expect(echoed.stderr).toContain('[redacted]')
  })

  it('keeps API key values out of the bash tool result', async () => {
    const env = envWithKey(workspace())
    const tools = new ToolRegistry({
      store: {} as Store,
      engine: {} as Engine,
      env,
      log: () => {},
      scheduleJob: () => {},
      routerTurn: async () => {},
    })
    const result = await tools.invoke(
      { id: 'call_bash', name: 'bash', args: { command: 'echo KEY=$DS_AGENT_API_KEY' } },
      { sessionId: 'w1', role: 'worker' },
    )
    expect(result).toEqual({ code: 0, stdout: 'KEY=', stderr: '' })
    expect(JSON.stringify(result)).not.toContain(secret)
  })
})

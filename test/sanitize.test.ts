import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import type { Engine } from '../src/core/engine.ts'
import { LocalEnv } from '../src/env/local-env.ts'
import { allowlistedEnv, isSecretEnvName, redactSecrets, secretValues } from '../src/env/sanitize.ts'
import { ToolRegistry } from '../src/harness/tools.ts'
import { Metrics } from '../src/metrics/metrics.ts'
import type { Runtime } from '../src/runtime.ts'
import type { Store } from '../src/store/sqlite.ts'
import { freshRuntime, shutdown } from './fixtures.ts'

const secret = 'sk-regression-key-9f3a7c'
let runtime: Runtime | undefined
const dirs: string[] = []

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('secret redaction', () => {
  it('treats API key names as secret and ignores short or ordinary values', () => {
    expect(isSecretEnvName('DS_AGENT_API_KEY')).toBe(true)
    expect(isSecretEnvName('OPENAI_API_KEY')).toBe(true)
    expect(isSecretEnvName('GITHUB_TOKEN')).toBe(true)
    expect(isSecretEnvName('PATH')).toBe(false)
    expect(isSecretEnvName('HOME')).toBe(false)
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

  it('never returns API key values from LocalEnv tool output', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-env-'))
    dirs.push(root)
    const env = new LocalEnv(root, {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DS_AGENT_API_KEY: secret,
        AWS_SECRET_ACCESS_KEY: `${secret}-aws`,
        FOO_LEAK: 'should-not-pass',
      },
      allowlist: ['PATH', 'HOME', 'DS_AGENT_API_KEY'],
    })
    const listed = await env.bash('w1', 'printenv')
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain('PATH=')
    expect(listed.stdout).not.toContain(secret)
    expect(listed.stdout).not.toContain('DS_AGENT_API_KEY')
    expect(listed.stdout).not.toContain('should-not-pass')
    expect(listed.stderr).not.toContain(secret)

    await env.writeFile('w1', 'leak.txt', `token=${secret}\naws=${secret}-aws\n`)
    const onDisk = fs.readFileSync(path.join(root, 'w1', 'leak.txt'), 'utf8')
    expect(onDisk).toContain(secret)
    const read = await env.readFile('w1', 'leak.txt')
    expect(read).not.toContain(secret)
    expect(read).toContain('[redacted]')

    const cat = await env.bash('w1', 'cat leak.txt')
    expect(cat.code).toBe(0)
    expect(cat.stdout).not.toContain(secret)
    expect(cat.stderr).not.toContain(secret)

    const echoed = await env.bash('w1', `printf '%s\\n' '${secret}' '${secret}-aws' >&2`)
    expect(echoed.stdout).not.toContain(secret)
    expect(echoed.stderr).not.toContain(secret)
    expect(echoed.stderr).toContain('[redacted]')

    const tools = new ToolRegistry({
      store: {} as Store,
      engine: {} as Engine,
      env,
      metrics: new Metrics(root),
      redact: text => redactSecrets(text, [secret, `${secret}-aws`]),
      log: () => {},
      scheduleJob: () => {},
      routerTurn: async () => {},
    })
    const bash = await tools.invoke(
      { id: 'call_bash', name: 'bash', args: { command: 'echo KEY=$DS_AGENT_API_KEY' } },
      { sessionId: 'w1', role: 'worker' },
    )
    const readTool = await tools.invoke(
      { id: 'call_read', name: 'read_file', args: { path: 'leak.txt' } },
      { sessionId: 'w1', role: 'worker' },
    )
    expect(bash).toEqual({ code: 0, stdout: 'KEY=', stderr: '' })
    expect(JSON.stringify(bash)).not.toContain(secret)
    expect(JSON.stringify(readTool)).not.toContain(secret)
    expect(JSON.stringify(readTool)).toContain('[redacted]')
  })

  it('keeps API key values out of prompts and session transcripts', async () => {
    runtime = freshRuntime({
      env: { ...process.env, DS_AGENT_API_KEY: secret, OPENAI_API_KEY: `${secret}-openai` },
    })
    runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: `@ds-agent please fix the login timeout ${secret} ${secret}-openai`,
    }))
    await runtime.jobsSettled()
    const bodies = runtime.store.listMessages().map(message => message.body).join('\n')
    expect(bodies).not.toContain(secret)
    expect(bodies).toContain('[redacted]')
    const sessions = path.join(runtime.home, 'sessions')
    const jsonl = fs.readdirSync(sessions)
      .filter(name => name.endsWith('.jsonl'))
      .map(name => fs.readFileSync(path.join(sessions, name), 'utf8'))
      .join('\n')
    expect(jsonl).not.toContain(secret)
    expect(runtime.log.text()).not.toContain(secret)
  })
})

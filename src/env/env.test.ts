import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalEnv } from './index.js'

describe('LocalEnv', () => {
  it('runs bash inside the workdir', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ds-agent-env-'))
    const env = new LocalEnv(dir)
    const result = await env.run('pwd && echo hello > note.txt')
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe(env.workdir)
    expect(readFileSync(path.join(env.workdir, 'note.txt'), 'utf8')).toBe('hello\n')
  })

  it('rejects a cwd that leaves the sandbox', async () => {
    const env = new LocalEnv(mkdtempSync(path.join(tmpdir(), 'ds-agent-env-')))
    await expect(env.run('pwd', { cwd: '../..' })).rejects.toThrow(/sandbox/)
    await expect(env.run('pwd', { cwd: '/tmp' })).rejects.toThrow(/sandbox/)
  })

  it('times out a long command', async () => {
    const env = new LocalEnv(mkdtempSync(path.join(tmpdir(), 'ds-agent-env-')))
    await expect(env.run('sleep 5', { timeoutMs: 200 })).rejects.toThrow(/SIGTERM/)
  })
})

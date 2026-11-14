import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dirs: string[] = []

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-cli-prompt-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function runCli(
  home: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, DS_AGENT_HOME: home, NODE_NO_WARNINGS: '1', ...extraEnv },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('ds-agent prompt', () => {
  it('prints one row per section with its source', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, 'SOUL.md'), 'Dry wit.\n')
    const result = runCli(home, ['prompt', '--layers'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/who-you-are\s+\d+ chars\s+built-in/)
    expect(result.stdout).toMatch(/soul\s+\d+ chars\s+<home>\/SOUL\.md/)
    expect(result.stdout).toMatch(/role\s+\d+ chars\s+built-in/)
  })

  it('prints the full router prompt by default', () => {
    const result = runCli(tempHome(), ['prompt'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('DeepSeek Super Agent')
    expect(result.stdout).toContain('MainSession')
  })

  it('renders the worker contract without router-only speech', () => {
    const result = runCli(tempHome(), ['prompt', '--role', 'worker'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('ExecutorSession')
    expect(result.stdout).not.toContain('reply_user')
  })

  it('emits sections as JSON when asked', () => {
    const result = runCli(tempHome(), ['prompt', '--layers', '--json'])
    expect(result.status, result.stderr).toBe(0)
    const sections = JSON.parse(result.stdout) as { id: string; source: string; text: string }[]
    expect(sections[0]?.id).toBe('who-you-are')
    expect(sections.at(-1)?.id).toBe('role')
    expect(sections[0]).toHaveProperty('source')
    expect(sections[0]).toHaveProperty('text')
  })

  it('labels a deprecated PERSONA.md fallback', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, 'PERSONA.md'), 'Legacy voice.\n')
    const result = runCli(home, ['prompt', '--layers'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/soul\s+\d+ chars\s+<home>\/PERSONA\.md \(deprecated fallback\)/)
  })

  it('labels an environment seed', () => {
    const result = runCli(tempHome(), ['prompt', '--layers'], { DS_AGENT_SOUL: 'Seeded voice.' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/soul\s+\d+ chars\s+env:DS_AGENT_SOUL/)
  })

  it('redacts a secret from a prompt file', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, 'USER.md'), 'api key: supersecret123\n')
    const result = runCli(home, ['prompt'], { DS_AGENT_API_KEY: 'supersecret123' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toContain('supersecret123')
    expect(result.stdout).toContain('[redacted]')
  })

  it('shows the configured local specialists in the team layer', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, 'local-agents.json'), JSON.stringify({
      agents: [{ id: 'claude', command: 'claude', description: 'Claude Code' }],
    }))
    const result = runCli(home, ['prompt', '--layers'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/team\s+\d+ chars\s+.*local-agents\.json/)
    const full = runCli(home, ['prompt'])
    expect(full.stdout).toContain('claude (Claude Code)')
  })

  it('rejects an unknown role', () => {
    const result = runCli(tempHome(), ['prompt', '--role', 'nope'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('role must be router, worker, or watchdog')
  })
})

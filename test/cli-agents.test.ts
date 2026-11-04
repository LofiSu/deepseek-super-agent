import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dirs: string[] = []

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-cli-agents-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function runCli(home: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, DS_AGENT_HOME: home, NODE_NO_WARNINGS: '1' },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('ds-agent agents', () => {
  it('lists the configured local agents', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, 'local-agents.json'), JSON.stringify({
      agents: [{
        id: 'claude',
        command: 'claude',
        args: ['-p', '{task}'],
        description: 'Claude Code',
      }],
    }))
    const result = runCli(home, ['agents'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('claude')
    expect(result.stdout).toContain('Claude Code')
  })

  it('emits the configuration as JSON', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, 'local-agents.json'), JSON.stringify({
      agents: [{ id: 'codex', command: 'codex', args: ['exec', '{task}'] }],
    }))
    const result = runCli(home, ['agents', '--json'])
    expect(result.status, result.stderr).toBe(0)
    const agents = JSON.parse(result.stdout) as { id: string }[]
    expect(agents.map(agent => agent.id)).toEqual(['codex'])
  })

  it('says so when nothing is configured', () => {
    const result = runCli(tempHome(), ['agents'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('no local agents configured')
  })
})

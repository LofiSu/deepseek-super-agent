import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dirs: string[] = []

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-cli-routines-'))
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

describe('ds-agent routines', () => {
  it('lists the configured routines with their cadence and channel', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, 'routines.json'), JSON.stringify([{
      id: 'deploy-check',
      everyMinutes: 60,
      prompt: 'Check production health.',
      source: 'imessage',
      thread: 'chat_42',
    }]))
    const result = runCli(home, ['routines'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('deploy-check')
    expect(result.stdout).toContain('every 60m')
    expect(result.stdout).toContain('imessage:chat_42')
  })

  it('emits the configuration as JSON', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, 'routines.json'), JSON.stringify([{
      id: 'morning',
      everyMinutes: 30,
      prompt: 'Brief me.',
    }]))
    const result = runCli(home, ['routines', '--json'])
    expect(result.status, result.stderr).toBe(0)
    const routines = JSON.parse(result.stdout) as { id: string; everyMinutes: number }[]
    expect(routines).toEqual([{
      id: 'morning',
      everyMinutes: 30,
      prompt: 'Brief me.',
      source: 'cli',
      thread: 'local',
      actor: 'you',
    }])
  })

  it('says so when nothing is configured', () => {
    const result = runCli(tempHome(), ['routines'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('no routines configured')
  })

  it('fails loudly on a malformed routine instead of silently never running it', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, 'routines.json'), JSON.stringify([{
      id: 'bad',
      everyMinutes: 0,
      prompt: 'Bad.',
    }]))
    const result = runCli(home, ['routines'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('everyMinutes')
  })
})

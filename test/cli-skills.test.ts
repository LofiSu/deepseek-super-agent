import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dirs: string[] = []

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-cli-skills-'))
  dirs.push(dir)
  return dir
}

function writeSkill(home: string, id: string, description: string): void {
  const dir = path.join(home, 'skills', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\ndescription: ${description}\n---\nbody\n`)
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

describe('ds-agent skills', () => {
  it('lists the configured playbooks', () => {
    const home = tempHome()
    writeSkill(home, 'deploy', 'Check the deploy health.')
    const result = runCli(home, ['skills'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('deploy')
    expect(result.stdout).toContain('Check the deploy health.')
  })

  it('emits the index as JSON', () => {
    const home = tempHome()
    writeSkill(home, 'release', 'Cut a release.')
    const result = runCli(home, ['skills', '--json'])
    expect(result.status, result.stderr).toBe(0)
    const skills = JSON.parse(result.stdout) as { id: string; description: string }[]
    expect(skills).toEqual([{ id: 'release', description: 'Cut a release.' }])
  })

  it('says so when nothing is configured', () => {
    const result = runCli(tempHome(), ['skills'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('no skills configured')
  })

  it('includes the skills index in the rendered prompt', () => {
    const home = tempHome()
    writeSkill(home, 'deploy', 'Check the deploy health.')
    const result = runCli(home, ['prompt', '--layers'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/skills\s+\d+ chars\s+.*skills/)
  })
})

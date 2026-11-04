import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/store/sqlite.ts'

const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

interface CliResult {
  status: number | null
  stdout: string
  stderr: string
}

function runCli(home: string, args: string[], env: NodeJS.ProcessEnv = {}): CliResult {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli/main.ts', ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DS_AGENT_HOME: home,
        NODE_NO_WARNINGS: '1',
        ...env,
      },
    },
  )
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** A temp home containing `ds-agent.db`, plus a fresh snapshot of it. */
function seededHomeWithSnapshot(): { home: string; snapshot: string } {
  const home = tempDir('ds-agent-wiring-home-')
  const out = tempDir('ds-agent-wiring-snap-')
  const init = runCli(home, ['init'])
  expect(init.status, init.stderr).toBe(0)

  const store = new Store(home)
  try {
    store.putDoc('ticket', 'ticket_cli_wiring', {
      id: 'ticket_cli_wiring',
      title: 'cli wiring fixture',
      speculative: false,
      threadKeys: [],
      channels: [],
      inputs: [],
      assignments: [],
      createdAt: '2026-11-04T00:00:00.000Z',
    })
  } finally {
    store.close()
  }

  const snapshot = path.join(out, 'snap.db')
  const backup = runCli(home, ['backup', '--out', snapshot])
  expect(backup.status, backup.stderr).toBe(0)
  return { home, snapshot }
}

describe('ds-agent ui / backup / restore wiring', () => {
  it('lists ui, backup, and restore in --help', () => {
    const result = runCli(tempDir('ds-agent-wiring-help-'), ['--help'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('ds-agent ui')
    expect(result.stdout).toContain('ds-agent backup')
    expect(result.stdout).toContain('ds-agent restore')
  })

  it('fails closed without a valid ui token and never starts listening', () => {
    const home = tempDir('ds-agent-wiring-ui-')
    for (const args of [['ui'], ['ui', '--token', 'too-short']]) {
      const result = runCli(home, args, { DS_AGENT_UI_TOKEN: '' })
      expect(result.status, result.stderr).not.toBe(0)
      expect(result.stderr).toContain('requires a token of at least 16 characters')
      expect(result.stdout).not.toContain('listening on')
    }
  })

  it('backs up to --out and restores with --force', () => {
    const { home, snapshot } = seededHomeWithSnapshot()
    expect(fs.existsSync(snapshot)).toBe(true)

    const restore = runCli(home, ['restore', snapshot, '--force'])
    expect(restore.status, restore.stderr).toBe(0)
    expect(fs.existsSync(path.join(home, 'ds-agent.db'))).toBe(true)
  })

  it('refuses restore over an existing store without --force and needs a path', () => {
    const { home, snapshot } = seededHomeWithSnapshot()

    const refused = runCli(home, ['restore', snapshot])
    expect(refused.status, refused.stderr).not.toBe(0)
    expect(refused.stderr.toLowerCase()).toContain('force')

    const missing = runCli(home, ['restore'])
    expect(missing.status, missing.stderr).not.toBe(0)
    expect(missing.stderr).toContain('Usage:')
  })
})

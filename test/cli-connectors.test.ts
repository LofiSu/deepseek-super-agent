import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONNECTORS_FILE } from '../src/connectors/config.ts'
import { ConnectorIndex } from '../src/connectors/index-store.ts'
import { Store } from '../src/store/sqlite.ts'

const dirs: string[] = []

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-cli-connectors-'))
  dirs.push(home)
  return home
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

describe('ds-agent connectors', () => {
  it('reports a disabled feature when connectors.json is absent', () => {
    const home = tempHome()
    const result = runCli(home, ['connectors', 'status'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('connectors disabled')
    expect(result.stdout).toContain('(absent)')
    expect(result.stdout).toContain('wake: disabled')
  })

  it('emits the configuration and index stats as JSON', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, CONNECTORS_FILE), JSON.stringify({ enabled: false }))
    const result = runCli(home, ['connectors', 'status', '--json'])
    expect(result.status, result.stderr).toBe(0)
    const summary = JSON.parse(result.stdout) as {
      enabled: boolean
      services: string[]
      stats: { count: number }
      wake: { enabled: boolean }
    }
    expect(summary.enabled).toBe(false)
    expect(summary.services).toHaveLength(7)
    expect(summary.stats.count).toBe(0)
    expect(summary.wake.enabled).toBe(false)
  })

  it('fails loudly for a malformed connectors.json', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, CONNECTORS_FILE), '{')
    const result = runCli(home, ['connectors', 'status'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('not valid JSON')
  })

  it('queries the connector index without a model or network call', () => {
    const home = tempHome()
    const store = new Store(home)
    new ConnectorIndex(store, { redact: text => text }).upsert([{
      service: 'gmail',
      kind: 'message',
      externalId: 'm1',
      title: 'Invoice for November',
      text: 'from=billing@example.com',
      occurredAt: '2026-11-05T10:00:00.000Z',
      updatedAt: '2026-11-05T10:00:00.000Z',
      wake: true,
      wakeReason: 'unread important mail',
    }])
    store.close()

    const result = runCli(home, ['connectors', 'query', 'invoice', '--json'])
    expect(result.status, result.stderr).toBe(0)
    const records = JSON.parse(result.stdout) as { id: string; title: string; service: string }[]
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ service: 'gmail', title: 'Invoice for November' })

    const text = runCli(home, ['connectors', 'query', 'invoice'])
    expect(text.status, text.stderr).toBe(0)
    expect(text.stdout).toContain('gmail:message')
    expect(text.stdout).toContain('Invoice for November')

    const none = runCli(home, ['connectors', 'query', 'unrelated-term'])
    expect(none.status, none.stderr).toBe(0)
    expect(none.stdout).toContain('no connector records')
  })
})

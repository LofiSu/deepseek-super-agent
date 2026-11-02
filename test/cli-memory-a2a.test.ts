import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/store/sqlite.ts'

const homes: string[] = []

function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-cli-state-'))
  homes.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function command(name: 'memory' | 'a2a', env: NodeJS.ProcessEnv): string {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli/main.ts', name],
    { encoding: 'utf8', env: { ...process.env, ...env, NODE_NO_WARNINGS: '1' } },
  )
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

describe('ds-agent memory / a2a', () => {
  it('reports an empty memory index', () => {
    const state = JSON.parse(command('memory', {
      DS_AGENT_HOME: home(),
      DS_AGENT_INSTANCE_ID: 'alpha',
    })) as { instance: string; memories: number; recent: unknown[] }
    expect(state).toMatchObject({ instance: 'alpha', memories: 0, recent: [] })
  })

  it('lists persisted memories and envelopes', () => {
    const dir = home()
    const store = new Store(dir)
    store.putDoc('ltm', 'ltm_ticket_1', {
      id: 'ltm_ticket_1',
      ticketId: 'ticket_1',
      spillId: 'ltm_spill_ticket_1',
      text: 'login timeout fixed',
      createdAt: '2026-11-02T00:00:00.000Z',
    })
    store.putDoc('a2a', 'a2a_1', {
      id: 'a2a_1',
      from: 'alpha',
      to: 'beta',
      body: { text: 'hello' },
      at: '2026-11-02T00:00:00.000Z',
    })
    store.close()

    const memory = JSON.parse(command('memory', { DS_AGENT_HOME: dir })) as {
      instance: string
      memories: number
      recent: { id: string }[]
    }
    expect(memory).toMatchObject({ instance: 'local', memories: 1 })
    expect(memory.recent[0]?.id).toBe('ltm_ticket_1')

    const a2a = JSON.parse(command('a2a', { DS_AGENT_HOME: dir })) as {
      envelopes: number
      recent: { id: string; from: string; to: string }[]
    }
    expect(a2a).toMatchObject({ envelopes: 1 })
    expect(a2a.recent[0]).toMatchObject({ id: 'a2a_1', from: 'alpha', to: 'beta' })
  })
})

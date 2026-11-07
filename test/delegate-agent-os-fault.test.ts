import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LocalAgentRegistry,
  type LocalAgentSpec,
} from '../src/env/local-agents.ts'
import { Store } from '../src/store/sqlite.ts'
import type { RecoveryBoundaryRecord } from '../src/core/recovery-boundary.ts'
import { RECOVERY_BOUNDARY_DOC_ID } from '../src/core/recovery-boundary.ts'
import type { Ticket } from '../src/shared/types.ts'

const children: ChildProcess[] = []
const homes: string[] = []

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-delegate-os-'))
  homes.push(dir)
  return dir
}

const delegateSpec = (fixture: string): LocalAgentSpec => ({
  id: 'ipc-echo',
  command: process.execPath,
  args: ['--import', 'tsx', fixture, '{task}'],
  timeoutMs: 30_000,
})

function markerPath(home: string): string {
  return path.join(home, '.delegate-os-ready')
}

function spawnRecoveryChild(home: string, mode: 'seed' | 'restart', task: string): ChildProcess {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'test/helpers/delegate-recovery-os-child.ts', home],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DS_AGENT_HOME: home,
        DS_AGENT_DELEGATE_TASK: task,
        DS_AGENT_RECOVERY_CHILD_MODE: mode,
        NODE_NO_WARNINGS: '1',
        DS_AGENT_ALLOW_MOCK_FIXTURE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(child)
  return child
}

async function waitForMarker(home: string, timeoutMs = 45_000): Promise<Record<string, unknown>> {
  const file = markerPath(home)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${file}`)
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('delegate_agent OS fault boundary', () => {
  it('SIGKILL during delegate_agent leaves recovery/latest completed; restart recovery then single delegate_agent', async () => {
    const home = tempHome()
    fs.writeFileSync(
      path.join(home, 'local-agents.json'),
      JSON.stringify({
        agents: [
          {
            id: 'ipc-hold',
            command: process.execPath,
            args: ['test/fixtures/delegate-ipc-hold.mjs', '{task}'],
            timeoutMs: 60_000,
          },
          {
            id: 'ipc-echo',
            command: process.execPath,
            args: ['--import', 'tsx', 'test/helpers/delegate-agent-os-child.ts', '{task}'],
            timeoutMs: 30_000,
          },
        ],
      }),
    )
    const task = 'delegate-crash-probe-task'
    const first = spawnRecoveryChild(home, 'seed', task)
    const during = await waitForMarker(home)
    expect(during.phase).toBe('delegating')
    expect(during.delegateActive).toBe(1)

    first.kill('SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 200))

    const store = new Store(home)
    try {
      const ticket = store.getDoc<Ticket>('ticket', 'ticket_delegate_os')!
      expect(ticket.assignments.length).toBeGreaterThanOrEqual(1)
      const last = ticket.assignments.at(-1)
      expect(['pending', 'running']).toContain(last?.state)
      const boundary = store.getDoc<RecoveryBoundaryRecord>('recovery', RECOVERY_BOUNDARY_DOC_ID)
      expect(boundary?.outcome).toBe('completed')
      expect(boundary?.model).toBe('ScriptedRecoveryModel')
    } finally {
      store.close()
    }

    fs.unlinkSync(markerPath(home))
    const second = spawnRecoveryChild(home, 'restart', task)
    const after = await waitForMarker(home)
    expect(after.phase).toBe('post-recovery')
    expect(after.recoveryOutcome).toBe('completed')
    expect(after.recoveredInputs).toBeGreaterThanOrEqual(1)
    expect(['pending', 'running']).toContain(after.lastAssignmentState)
    second.kill('SIGTERM')
  }, 90_000)

  it('killAll on LocalAgentRegistry ends a slow specialist without duplicate stdout replay', async () => {
    const slow: LocalAgentSpec = {
      id: 'slow',
      command: process.execPath,
      args: ['--import', 'tsx', 'test/fixtures/local-agent-fixture.mjs', 'slow'],
      timeoutMs: 60_000,
    }
    const reg = new LocalAgentRegistry([slow], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      workspace: () => fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-ws-')),
    })
    const pending = reg.run('slow', 'wait', 'worker_kill')
    for (let i = 0; i < 100 && reg.activeCount === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(reg.activeCount).toBe(1)
    reg.killAll()
    const result = await pending
    expect(result.code).not.toBe(0)
    expect(reg.activeCount).toBe(0)
    await expect(reg.run('slow', 'again', 'worker_kill')).rejects.toThrow(/shut down/)
  })
})


import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RecoveryBoundaryRecord } from '../src/core/recovery-boundary.ts'
import { RECOVERY_BOUNDARY_DOC_ID } from '../src/core/recovery-boundary.ts'
import type { Ticket } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'

/**
 * OS process kill/restart coverage for ADR-004. Uses a real child Node process
 * and SIGKILL — not only in-process mocks.
 */

const homes: string[] = []
const children: ChildProcess[] = []

const OFFLINE_KEYS = [
  'DS_AGENT_API_BASE',
  'DS_AGENT_API_KEY',
  'DS_AGENT_API_MODEL',
  'DS_AGENT_PROVIDER',
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
]

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-os-fault-'))
  homes.push(dir)
  return dir
}

function markerPath(home: string): string {
  return path.join(home, '.recovery-child-ready')
}

function childEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DS_AGENT_HOME: home, NODE_NO_WARNINGS: '1' }
  for (const key of OFFLINE_KEYS) delete env[key]
  return { ...env, ...extra }
}

function startChild(home: string, mode: 'seed' | 'restart'): ChildProcess {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'test/helpers/recovery-os-child.ts', home],
    {
      cwd: process.cwd(),
      env: childEnv(home, { DS_AGENT_RECOVERY_CHILD_MODE: mode }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(child)
  return child
}

async function waitForMarker(home: string, timeoutMs = 30_000): Promise<void> {
  const file = markerPath(home)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for recovery marker at ${file}`)
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('restart recovery OS fault', () => {
  it('SIGKILL during serve leaves persisted recovery boundary and ticket state for the next process', async () => {
    const home = tempHome()
    const child = startChild(home, 'seed')
    await waitForMarker(home)

    child.kill('SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 200))

    const store = new Store(home)
    try {
      const ticket = store.getDoc<Ticket>('ticket', 'ticket_os_fault')!
      expect(ticket.assignments.length).toBeGreaterThanOrEqual(2)
      expect(ticket.assignments[0]?.state).toBe('ended')
      // Recovery may have already scheduled the relaunch before SIGKILL.
      expect(['pending', 'running']).toContain(ticket.assignments[1]?.state)
      expect(ticket.inputs.some(input => input.text?.startsWith('RECOVERED:'))).toBe(true)
      const boundary = store.getDoc<RecoveryBoundaryRecord>('recovery', RECOVERY_BOUNDARY_DOC_ID)
      expect(boundary?.outcome).toBe('completed')
      expect(boundary?.model).toBe('ScriptedRecoveryModel')
      expect(boundary?.tickets.some(t => t.ticketId === 'ticket_os_fault')).toBe(true)
    } finally {
      store.close()
    }

    fs.unlinkSync(markerPath(home))
    const second = startChild(home, 'restart')
    await waitForMarker(home)
    second.kill('SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 500))

    const after = new Store(home)
    try {
      const boundary = after.getDoc<RecoveryBoundaryRecord>('recovery', RECOVERY_BOUNDARY_DOC_ID)
      expect(boundary?.outcome).toBe('completed')
      const transition = boundary?.tickets.find(t => t.ticketId === 'ticket_os_fault')?.transition
      expect(['relaunch_only', 'relaunch_scheduled', 'recovered']).toContain(transition)
    } finally {
      after.close()
    }
  }, 60_000)
})

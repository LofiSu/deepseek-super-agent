import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Ticket } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'

const children: ChildProcess[] = []
const homes: string[] = []

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-approval-os-'))
  homes.push(dir)
  return dir
}

function markerPath(home: string): string {
  return path.join(home, '.recovery-approval-child-ready')
}

function spawnChild(home: string): ChildProcess {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'test/helpers/recovery-approval-os-child.ts', home],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DS_AGENT_HOME: home,
        NODE_NO_WARNINGS: '1',
        DS_AGENT_ALLOW_MOCK_FIXTURE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(child)
  return child
}

async function waitForMarker(home: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
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

describe('restart recovery approval hold (OS process)', () => {
  it('Runtime.start recovery skips approval-held tickets and recovers a normal running ticket without replaying approval state', async () => {
    const home = tempHome()
    spawnChild(home)
    const snapshot = await waitForMarker(home)

    expect(snapshot.approvalPending).toBe('pending')
    expect(snapshot.heldAssignments).toBe(1)
    expect(snapshot.heldRecoveredInputs).toBe(0)
    expect(snapshot.normalAssignments).toBe(2)
    expect(snapshot.normalRecoveredInputs).toBeGreaterThanOrEqual(1)

    const store = new Store(home)
    try {
      const held = store.getDoc<Ticket>('ticket', 'ticket_approval_held')!
      expect(held.assignments).toHaveLength(1)
      expect(held.assignments[0]?.state).toBe('running')
      expect(held.collab?.approvals?.[0]?.status).toBe('pending')
      expect(held.inputs.some(i => i.text?.startsWith('RECOVERED:'))).toBe(false)

      const normal = store.getDoc<Ticket>('ticket', 'ticket_normal')!
      expect(normal.assignments.length).toBeGreaterThanOrEqual(2)
      expect(normal.assignments[0]?.state).toBe('ended')
      expect(normal.inputs.some(i => i.text?.startsWith('RECOVERED:'))).toBe(true)
    } finally {
      store.close()
    }
  }, 60_000)
})

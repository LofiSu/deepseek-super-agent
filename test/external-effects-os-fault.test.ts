import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EXTERNAL_OP_KIND,
  UNKNOWN_OUTCOME_PREFIX,
  type ExternalOperationRecord,
} from '../src/core/external-effects.ts'
import { RECOVERY_BOUNDARY_DOC_ID, type RecoveryBoundaryRecord } from '../src/core/recovery-boundary.ts'
import type { Ticket } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'

describe('external effects unknown-outcome gate (OS fault)', () => {
  const children: ChildProcess[] = []
  const homes: string[] = []

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
  })

  function tempHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-ext-os-'))
    homes.push(dir)
    return dir
  }

  it('SIGKILL during delegate_agent queues UNKNOWN-OUTCOME approval and skips auto recovery replay', async () => {
    const home = tempHome()
    fs.writeFileSync(
      path.join(home, 'local-agents.json'),
      JSON.stringify({
        agents: [{
          id: 'ipc-hold',
          command: process.execPath,
          args: ['test/fixtures/delegate-ipc-hold.mjs', '{task}'],
          timeoutMs: 60_000,
        }],
      }),
    )
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'test/helpers/delegate-recovery-os-child.ts', home],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DS_AGENT_HOME: home,
          DS_AGENT_DELEGATE_TASK: 'ext-gate-task',
          DS_AGENT_RECOVERY_CHILD_MODE: 'seed',
          NODE_NO_WARNINGS: '1',
          DS_AGENT_ALLOW_MOCK_FIXTURE: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    children.push(child)
    const marker = path.join(home, '.delegate-os-ready')
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      if (fs.existsSync(marker)) break
      await new Promise(r => setTimeout(r, 25))
    }
    child.kill('SIGKILL')
    await new Promise(r => setTimeout(r, 150))

    const restart = spawn(
      process.execPath,
      ['--import', 'tsx', 'test/helpers/delegate-recovery-os-child.ts', home],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DS_AGENT_HOME: home,
          DS_AGENT_DELEGATE_TASK: 'ext-gate-task',
          DS_AGENT_RECOVERY_CHILD_MODE: 'restart',
          NODE_NO_WARNINGS: '1',
          DS_AGENT_ALLOW_MOCK_FIXTURE: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    children.push(restart)
    fs.unlinkSync(marker)
    while (Date.now() < deadline) {
      if (fs.existsSync(marker)) break
      await new Promise(r => setTimeout(r, 25))
    }
    restart.kill('SIGTERM')

    const store = new Store(home)
    try {
      const ticket = store.getDoc<Ticket>('ticket', 'ticket_delegate_os')!
      const pending = ticket.collab?.approvals?.find(a => a.status === 'pending')
      expect(pending?.action.startsWith(UNKNOWN_OUTCOME_PREFIX)).toBe(true)
      expect(ticket.inputs.some(i => i.text?.startsWith('RECOVERED:'))).toBe(false)
      const ops = store.listDocs<ExternalOperationRecord>(EXTERNAL_OP_KIND)
      expect(ops.some(o => o.phase === 'unknown_outcome')).toBe(true)
      const boundary = store.getDoc<RecoveryBoundaryRecord>('recovery', RECOVERY_BOUNDARY_DOC_ID)
      expect(boundary?.outcome).toBe('completed')
      expect(boundary?.tickets.some(t => t.ticketId === 'ticket_delegate_os')).toBe(false)
    } finally {
      store.close()
    }
  }, 90_000)
})

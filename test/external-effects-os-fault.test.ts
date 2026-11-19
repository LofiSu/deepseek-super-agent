import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
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
import { runDelegateOsSupervisor } from './helpers/delegate-os-supervisor.ts'

describe('external effects unknown-outcome gate (OS fault)', () => {
  const children: ChildProcess[] = []
  const closedChildren = new WeakSet<ChildProcess>()
  const homes: string[] = []

  function trackChild(child: ChildProcess): ChildProcess {
    child.once('close', () => closedChildren.add(child))
    children.push(child)
    return child
  }

  async function waitForClose(child: ChildProcess): Promise<void> {
    if (!closedChildren.has(child)) await once(child, 'close')
  }

  afterEach(async () => {
    const pending = children.splice(0)
    for (const child of pending) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    await Promise.all(pending.map(waitForClose))
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
  })

  function tempHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-ext-os-'))
    homes.push(dir)
    return dir
  }

  it('delegate hold fixture stays alive with stdin ignored', async () => {
    const child = spawn(
      process.execPath,
      [path.resolve(process.cwd(), 'test/fixtures/delegate-ipc-hold.mjs')],
      { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore'] },
    )
    trackChild(child)
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', reject)
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(child.exitCode).toBeNull()
    expect(child.signalCode).toBeNull()
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    child.kill('SIGKILL')
    await closed
  })

  it('SIGKILL during delegate_agent queues UNKNOWN-OUTCOME approval and skips auto recovery replay', async () => {
    const home = tempHome()
    fs.writeFileSync(
      path.join(home, 'local-agents.json'),
      JSON.stringify({
        agents: [{
          id: 'ipc-hold',
          command: process.execPath,
          args: [path.resolve(process.cwd(), 'test/fixtures/delegate-ipc-hold.mjs'), '{task}'],
          env: ['DS_AGENT_TEST_DELEGATE_PID_FILE'],
          timeoutMs: 60_000,
        }],
      }),
    )
    const supervisor = await runDelegateOsSupervisor('fault', home, 'ext-gate-task')
    expect(supervisor.helper_exit_signal).toBe(9)
    expect(supervisor.helper_waited).toBe(true)
    expect(supervisor.delegate_pid).toBeGreaterThan(0)
    expect(supervisor.group_signal_sent).toBe(true)
    expect(supervisor.group_absent).toBe(true)
    expect(supervisor.reaped_pids).toContain(supervisor.delegate_pid)
    expect(supervisor.reaped_delegate_pid).toBe(true)
    const marker = path.join(home, '.delegate-os-ready')
    const during = JSON.parse(fs.readFileSync(marker, 'utf8')) as Record<string, unknown>
    expect(during.durableStarted).toBe(true)
    expect(during.delegateOperationPhase).toBe('started')

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
    trackChild(restart)
    fs.unlinkSync(marker)
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      if (fs.existsSync(marker)) break
      await new Promise(r => setTimeout(r, 25))
    }
    expect(fs.existsSync(marker)).toBe(true)
    restart.kill('SIGTERM')
    await waitForClose(restart)

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

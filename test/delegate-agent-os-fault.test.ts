import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalAgentRegistry, type LocalAgentSpec } from '../src/env/local-agents.ts'
import { Store } from '../src/store/sqlite.ts'
import type { Ticket } from '../src/shared/types.ts'
import { delegateOsSupervisorSupported, runDelegateOsSupervisor } from './helpers/delegate-os-supervisor.ts'

const children: ChildProcess[] = []
const closedChildren = new WeakSet<ChildProcess>()
const homes: string[] = []

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-delegate-os-'))
  homes.push(dir)
  return dir
}

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
  child.once('close', () => closedChildren.add(child))
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

async function waitForExit(child: ChildProcess): Promise<void> {
  if (!closedChildren.has(child)) await once(child, 'close')
}

afterEach(async () => {
  const pending = children.splice(0)
  for (const child of pending) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  await Promise.all(pending.map(waitForExit))
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

const osFaultDescribe = delegateOsSupervisorSupported() ? describe : describe.skip

osFaultDescribe('delegate_agent OS fault boundary', () => {
  it('SIGKILL during delegate_agent holds UNKNOWN-OUTCOME approval instead of auto RECOVERED replay', async () => {
    const home = tempHome()
    fs.writeFileSync(
      path.join(home, 'local-agents.json'),
      JSON.stringify({
        agents: [
          {
            id: 'ipc-hold',
            command: process.execPath,
            // Local specialists run in their Worker workspace, not the
            // repository root. Keep this fixture path valid across that
            // boundary so the effect remains in-flight until SIGKILL.
            args: [path.resolve(process.cwd(), 'test/fixtures/delegate-ipc-hold.mjs'), '{task}'],
            env: ['DS_AGENT_TEST_DELEGATE_PID_FILE'],
            timeoutMs: 60_000,
          },
          {
            id: 'ipc-echo',
            command: process.execPath,
            args: ['--import', 'tsx', path.resolve(process.cwd(), 'test/helpers/delegate-agent-os-child.ts'), '{task}'],
            timeoutMs: 30_000,
          },
        ],
      }),
    )
    const task = 'delegate-crash-probe-task'
    const supervisor = await runDelegateOsSupervisor('fault', home, task)
    expect(supervisor.subreaper).toBe(true)
    expect(supervisor.helper_exit_signal).toBe(9)
    expect(supervisor.helper_waited).toBe(true)
    expect(supervisor.delegate_pid).toBeGreaterThan(0)
    expect(supervisor.delegate_pgid).toBe(supervisor.delegate_pid)
    expect(supervisor.group_signal_sent).toBe(true)
    expect(supervisor.group_absent).toBe(true)
    expect(supervisor.reaped_pids).toContain(supervisor.delegate_pid)
    expect(supervisor.reaped_delegate_pid).toBe(true)
    const during = JSON.parse(fs.readFileSync(markerPath(home), 'utf8')) as Record<string, unknown>
    expect(during.phase).toBe('delegating')
    expect(during.delegateActive).toBe(1)
    expect(during.delegateOperationPhase).toBe('started')
    expect(during.delegateOperationId).toMatch(/^extop_/)
    expect(during.durableStarted).toBe(true)

    const store = new Store(home)
    try {
      const ticket = store.getDoc<Ticket>('ticket', 'ticket_delegate_os')!
      expect(ticket.assignments.length).toBeGreaterThanOrEqual(1)
      const last = ticket.assignments.at(-1)
      expect(['pending', 'running']).toContain(last?.state)
    } finally {
      store.close()
    }

    fs.unlinkSync(markerPath(home))
    const second = spawnRecoveryChild(home, 'restart', task)
    const after = await waitForMarker(home)
    expect(after.phase).toBe('post-recovery')
    expect(after.recoveryOutcome).toBe('completed')
    expect(after.assignmentCount).toBe(1)
    expect(after.lastAssignmentState).toBe('running')
    expect(after.recoveredInputs).toBe(0)
    expect(after.unknownApprovals).toBeGreaterThanOrEqual(1)
    second.kill('SIGTERM')
    await waitForExit(second)
  }, 90_000)

  it('fails closed when the launching worker exits before supervisor parent-death setup', async () => {
    const home = tempHome()
    const raceHarness = spawn(
      'python3',
      [
        path.resolve(process.cwd(), 'test/helpers/delegate-os-parent-race.py'),
        home,
        process.cwd(),
        path.resolve(process.cwd(), 'test/helpers/delegate-os-supervisor.py'),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, DS_AGENT_NODE: process.execPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    raceHarness.once('close', () => closedChildren.add(raceHarness))
    children.push(raceHarness)
    let stdout = ''
    let stderr = ''
    raceHarness.stdout?.setEncoding('utf8')
    raceHarness.stderr?.setEncoding('utf8')
    raceHarness.stdout?.on('data', chunk => { stdout += chunk })
    raceHarness.stderr?.on('data', chunk => { stderr += chunk })
    await waitForExit(raceHarness)

    expect(raceHarness.exitCode, stderr || stdout).toBe(0)
    const result = JSON.parse(stdout.trim()) as Record<string, unknown>
    expect(result.worker_exited_before_supervisor_setup).toBe(true)
    expect(result.supervisor_exit_code).not.toBe(0)
    expect((result.supervisor_report as Record<string, unknown>).fatal).toContain('launching worker PID mismatch')
    expect(result.helper_launch_attempted).toBe(false)
    expect(result.recovery_helper_marker_exists).toBe(false)
    expect(result.delegate_pid_file_exists).toBe(false)
    expect(result.remaining_owned_children).toEqual([])
  }, 30_000)

  it.each([
    ['assertion-failure', 'AssertionError'],
    ['timeout-failure', 'TimeoutError'],
  ] as const)('supervisor kills and reaps the delegate on %s', async (mode, failureKind) => {
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

    const report = await runDelegateOsSupervisor(mode, home)
    expect(report.failure_kind).toBe(failureKind)
    expect(report.expected_failure).toBe(true)
    if (mode === 'timeout-failure') expect(report.injected_timeout_checkpoint).toBe(true)
    expect(report.helper_waited).toBe(true)
    expect(report.group_signal_sent).toBe(true)
    expect(report.group_absent).toBe(true)
    expect(report.delegate_pid).toBeGreaterThan(0)
    expect(report.reaped_pids).toContain(report.delegate_pid)
    expect(report.reaped_delegate_pid).toBe(true)
    expect(report.cleanup_error).toBeNull()
  }, 90_000)

  it('kills and reaps a spawned child when owner-file publication fails', async () => {
    const home = tempHome()
    const pidAudit = path.join(home, 'spawned-child.pid')
    const registry = new LocalAgentRegistry([{
      id: 'ipc-hold',
      command: process.execPath,
      args: [path.resolve(process.cwd(), 'test/fixtures/delegate-ipc-hold.mjs'), '{task}'],
      timeoutMs: 60_000,
    }], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        DS_AGENT_TEST_DELEGATE_OWNER_FILE: path.join(home, 'missing', 'owner.json'),
        DS_AGENT_TEST_DELEGATE_OWNER_ACK: path.join(home, 'owner.ack'),
        DS_AGENT_TEST_DELEGATE_OWNER_PID_AUDIT: pidAudit,
      },
      workspace: () => path.join(home, 'workspace'),
    })

    await expect(registry.run('ipc-hold', 'publication failure', 'worker_owner_io'))
      .rejects.toThrow(/could not initialize local agent/)
    expect(registry.activeCount).toBe(0)
    const spawnedPid = Number(fs.readFileSync(pidAudit, 'utf8').trim())
    expect(spawnedPid).toBeGreaterThan(1)
    expect(() => process.kill(spawnedPid, 0)).toThrow()
    registry.killAll()
  })

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
    try {
      for (let i = 0; i < 100 && reg.activeCount === 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(reg.activeCount).toBe(1)
      reg.killAll()
      const result = await pending
      expect(result.code).not.toBe(0)
      expect(reg.activeCount).toBe(0)
      await expect(reg.run('slow', 'again', 'worker_kill')).rejects.toThrow(/shut down/)
    } finally {
      reg.killAll()
      await pending.catch(() => undefined)
    }
  })
})

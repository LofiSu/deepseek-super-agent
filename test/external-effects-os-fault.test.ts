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
import { delegateOsSupervisorSupported, runDelegateOsSupervisor } from './helpers/delegate-os-supervisor.ts'
import { runDelegateCapabilityProbe } from './helpers/delegate-os-capability-probe.ts'

const osFaultDescribe = delegateOsSupervisorSupported() ? describe : describe.skip

osFaultDescribe('external effects unknown-outcome gate (OS fault)', () => {
  it.each([
    'open_enosys', 'signal_enosys', 'missing_open', 'missing_signal',
    'permission_open', 'permission_signal',
  ])('rejects unsupported %s before creating the helper or fixture', async stage => {
    const result = await runDelegateCapabilityProbe(stage)
    try {
      expect(result.exitCode).toBe(0)
      expect(result.report?.wrapperRejected).toBe(true)
      expect(result.report?.outer_guard_live_rescues).toEqual([])
      expect(result.report?.outer_guard_clean).toBe(true)
      const report = result.report?.supervisor_report as Record<string, unknown>
      expect(report.failure_kind).toBe('UnsupportedCapability')
      expect(String(report.unsupported_capability)).toContain('unsupported capability:')
      expect(report.helper_created).toBe(false)
      expect(report.helper_pid).toBeNull()
      expect(fs.existsSync(path.join(result.home, 'helper-launch-attempted'))).toBe(false)
      expect(fs.existsSync(path.join(result.home, '.delegate-fixture.pid'))).toBe(false)
    } finally {
      fs.rmSync(result.home, { recursive: true, force: true })
    }
  })

  it.each(['open_late', 'signal_late'])(
    'reports late %s failure and safely reaps its exact direct child', async stage => {
      const result = await runDelegateCapabilityProbe(stage)
      try {
        expect(result.exitCode).toBe(0)
        expect(result.report?.wrapperRejected).toBe(true)
        expect(result.report?.outer_guard_live_rescues).toEqual([])
        expect(result.report?.outer_guard_clean).toBe(true)
        const report = result.report?.supervisor_report as Record<string, unknown>
        expect(report.helper_created).toBe(true)
        expect(report.operational_failure).toContain('failed after preflight')
        expect(report.safe_direct_child_fallback_used).toBe(true)
        expect(report.group_absent).toBe(true)
        expect(report.reaped_delegate_pid).toBe(true)
        expect(report.cleanup_succeeded).toBe(false)
      } finally {
        fs.rmSync(result.home, { recursive: true, force: true })
      }
    },
  )

  it.each(['missing_open', 'missing_signal'])(
    'fails the outer rescue guard before it launches a wrapper when %s is unavailable', async stage => {
      const result = await runDelegateCapabilityProbe(stage, 'outer-guard')
      try {
        expect(result.exitCode).toBe(1)
        expect(result.report?.guard_error).toContain('unsupported capability:')
        expect(fs.existsSync(path.join(result.home, 'helper-launch-attempted'))).toBe(false)
        expect(fs.existsSync(path.join(result.home, '.delegate-fixture.pid'))).toBe(false)
      } finally {
        fs.rmSync(result.home, { recursive: true, force: true })
      }
    },
  )

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

  it('isolates baseline and unrelated children across repeated cleanup and reentry', async () => {
    const home = tempHome()
    const child = spawn(
      'python3',
      [path.resolve(process.cwd(), 'test/helpers/delegate-os-capability-domain-probe.py'),
        home, process.cwd(), process.execPath],
      { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    trackChild(child)
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    await waitForClose(child)
    expect(child.exitCode, stderr || stdout).toBe(0)
    const result = JSON.parse(stdout.trim()) as Record<string, unknown>
    expect(result.baseline_alive_after_all).toBe(true)
    expect(result.unrelated_alive_after_all).toBe(true)
    const cases = result.cases as Array<Record<string, unknown>>
    expect(cases).toHaveLength(3)
    for (const entry of cases) {
      expect(entry.baseline_alive).toBe(true)
      expect(entry.unrelated_alive).toBe(true)
      expect((entry.cleanup as Record<string, unknown>).reaped_delegate_pid).toBe(true)
      expect((entry.reentry as Record<string, unknown>).group_absent).toBe(true)
      expect((entry.reentry as Record<string, unknown>).group_signal_sent).toBe(false)
    }
  }, 30_000)

  it('delegate hold fixture stays alive after fixture-level readiness with stdin ignored', async () => {
    const home = tempHome()
    const readyFile = path.join(home, 'fixture.ready')
    const child = spawn(
      process.execPath,
      [path.resolve(process.cwd(), 'test/fixtures/delegate-ipc-hold.mjs')],
      {
        cwd: process.cwd(),
        env: { ...process.env, DS_AGENT_TEST_FIXTURE_READY_FILE: readyFile },
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    )
    trackChild(child)
    let closed = false
    child.once('close', () => { closed = true })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', reject)
    })
    const deadline = Date.now() + 5_000
    while (!fs.existsSync(readyFile) && Date.now() < deadline) {
      if (closed) throw new Error('hold fixture closed before publishing fixture readiness')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(fs.existsSync(readyFile)).toBe(true)
    expect(closed).toBe(false)
    expect(child.exitCode).toBeNull()
    expect(child.signalCode).toBeNull()
    const closePromise = new Promise<void>(resolve => child.once('close', () => resolve()))
    child.kill('SIGKILL')
    await closePromise
  })

  it('cleans and reaps a fixture when the real wrapper deadline precedes fixture PID publication', async () => {
    const home = tempHome()
    fs.writeFileSync(
      path.join(home, 'local-agents.json'),
      JSON.stringify({ agents: [{
        id: 'ipc-hold',
        command: process.execPath,
        args: [path.resolve(process.cwd(), 'test/fixtures/delegate-ipc-hold.mjs'), '{task}'],
        env: ['DS_AGENT_TEST_DELEGATE_PID_FILE', 'DS_AGENT_TEST_FIXTURE_START_DELAY_MS'],
        timeoutMs: 60_000,
      }] }),
    )
    const guard = spawn(
      'python3',
      [path.resolve(process.cwd(), 'test/helpers/delegate-os-wrapper-timeout-guard.py'),
        process.cwd(), home, '5000'],
      {
        cwd: process.cwd(),
        env: { ...process.env, DS_AGENT_NODE: process.execPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    trackChild(guard)
    let stdout = ''
    let stderr = ''
    guard.stdout?.setEncoding('utf8')
    guard.stderr?.setEncoding('utf8')
    guard.stdout?.on('data', chunk => { stdout += chunk })
    guard.stderr?.on('data', chunk => { stderr += chunk })
    await waitForClose(guard)
    expect(guard.exitCode, stderr || stdout).toBe(0)
    const result = JSON.parse(stdout.trim()) as Record<string, unknown>
    expect(result.wrapperRejected).toBe(true)
    expect(result.errorName).toBe('DelegateOsSupervisorError')
    expect(result.outer_guard_clean).toBe(true)
    expect(result.outer_guard_rescued_live_fixture).toBe(false)
    const report = result.report as Record<string, unknown>
    expect(report.failure_kind).toBe('SupervisorInterrupted')
    expect(report.creation_identity_pinned).toBe(true)
    expect(report.owner_acknowledged).toBe(true)
    expect(report.delegate_pid).toBeGreaterThan(0)
    expect(report.group_signal_sent).toBe(true)
    expect(report.reaped_delegate_pid).toBe(true)
    expect(report.cleanup_succeeded).toBe(true)
    expect(fs.existsSync(path.join(home, '.delegate-fixture.pid'))).toBe(false)
  })

  it('cleans a real wrapper timeout while the spawned fixture has no owner record', async () => {
    const home = tempHome()
    fs.writeFileSync(
      path.join(home, 'local-agents.json'),
      JSON.stringify({ agents: [{
        id: 'ipc-hold',
        command: process.execPath,
        args: [path.resolve(process.cwd(), 'test/fixtures/delegate-ipc-hold.mjs'), '{task}'],
        env: ['DS_AGENT_TEST_DELEGATE_OWNER_PREPUBLISH_GATE'],
        timeoutMs: 60_000,
      }] }),
    )
    const reportFile = path.join(home, 'supervisor-report.json')
    const guard = spawn(
      'python3',
      [path.resolve(process.cwd(), 'test/helpers/delegate-os-wrapper-timeout-guard.py'),
        process.cwd(), home, '0'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DS_AGENT_NODE: process.execPath,
          DS_AGENT_TEST_SUPERVISOR_MODE: 'prepublish-timeout',
          DS_AGENT_TEST_SUPERVISOR_REPORT_FILE: reportFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    trackChild(guard)
    let stdout = ''
    let stderr = ''
    guard.stdout?.setEncoding('utf8')
    guard.stderr?.setEncoding('utf8')
    guard.stdout?.on('data', chunk => { stdout += chunk })
    guard.stderr?.on('data', chunk => { stderr += chunk })
    await waitForClose(guard)
    expect(guard.exitCode, stderr || stdout).toBe(0)
    const result = JSON.parse(stdout.trim()) as Record<string, unknown>
    expect(result.wrapperRejected).toBe(true)
    expect(result.outer_guard_rescued_live_fixture).toBe(false)
    expect(result.outer_guard_live_rescues).toEqual([])
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as Record<string, unknown>
    expect(report.failure_kind).toBe('SupervisorInterrupted')
    expect(report.creation_identity_source).toBe('subreaper-adopted-child')
    expect(report.owner_acknowledged).toBe(false)
    expect(report.creation_identity_pinned).toBe(true)
    expect(report.helper_waited).toBe(true)
    expect(report.group_signal_sent).toBe(true)
    expect(report.group_absent).toBe(true)
    expect(report.reaped_delegate_pid).toBe(true)
    expect(report.cleanup_succeeded).toBe(true)
    expect(fs.existsSync(path.join(home, '.delegate-owner-prepublish.gate'))).toBe(true)
    expect(fs.existsSync(path.join(home, '.delegate-owner-at-spawn.json'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.delegate-fixture.pid'))).toBe(false)
  }, 30_000)

  it('owns and reaps the delegate before a withheld owner acknowledgment at wrapper timeout', async () => {
    const home = tempHome()
    fs.writeFileSync(
      path.join(home, 'local-agents.json'),
      JSON.stringify({ agents: [{
        id: 'ipc-hold',
        command: process.execPath,
        args: [path.resolve(process.cwd(), 'test/fixtures/delegate-ipc-hold.mjs'), '{task}'],
        env: ['DS_AGENT_TEST_DELEGATE_PID_FILE', 'DS_AGENT_TEST_FIXTURE_START_DELAY_MS'],
        timeoutMs: 60_000,
      }] }),
    )
    fs.mkdirSync(path.join(home, '.delegate-owner-at-spawn.ack'))
    const guard = spawn(
      'python3',
      [path.resolve(process.cwd(), 'test/helpers/delegate-os-wrapper-timeout-guard.py'),
        process.cwd(), home, '5000'],
      {
        cwd: process.cwd(),
        env: { ...process.env, DS_AGENT_NODE: process.execPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    trackChild(guard)
    let stdout = ''
    let stderr = ''
    guard.stdout?.setEncoding('utf8')
    guard.stderr?.setEncoding('utf8')
    guard.stdout?.on('data', chunk => { stdout += chunk })
    guard.stderr?.on('data', chunk => { stderr += chunk })
    await waitForClose(guard)
    expect(guard.exitCode, stderr || stdout).toBe(0)
    const result = JSON.parse(stdout.trim()) as Record<string, unknown>
    expect(result.wrapperRejected).toBe(true)
    expect(result.outer_guard_clean).toBe(true)
    expect(result.outer_guard_rescued_live_fixture).toBe(false)
    const report = result.report as Record<string, unknown>
    expect(report.owner_acknowledged).toBe(false)
    expect(report.failure_kind).toBe('SupervisorInterrupted')
    expect(report.creation_identity_pinned).toBe(true)
    expect(report.delegate_pid).toBeGreaterThan(0)
    expect(report.group_signal_sent).toBe(true)
    expect(report.reaped_delegate_pid).toBe(true)
    expect(report.cleanup_succeeded).toBe(true)
    expect(fs.existsSync(path.join(home, '.delegate-fixture.pid'))).toBe(false)
  })

  it('reaps a real detached fixture when its helper dies before owner publication', async () => {
    const home = tempHome()
    fs.writeFileSync(
      path.join(home, 'local-agents.json'),
      JSON.stringify({ agents: [{
        id: 'ipc-hold',
        command: process.execPath,
        args: [path.resolve(process.cwd(), 'test/fixtures/delegate-ipc-hold.mjs'), '{task}'],
        env: ['DS_AGENT_TEST_DELEGATE_OWNER_PREPUBLISH_GATE'],
        timeoutMs: 60_000,
      }] }),
    )
    const guard = spawn(
      'python3',
      [path.resolve(process.cwd(), 'test/helpers/delegate-os-wrapper-timeout-guard.py'),
        process.cwd(), home, '5000'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DS_AGENT_NODE: process.execPath,
          DS_AGENT_TEST_SUPERVISOR_MODE: 'prepublish-kill',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    trackChild(guard)
    let stdout = ''
    let stderr = ''
    guard.stdout?.setEncoding('utf8')
    guard.stderr?.setEncoding('utf8')
    guard.stdout?.on('data', chunk => { stdout += chunk })
    guard.stderr?.on('data', chunk => { stderr += chunk })
    await waitForClose(guard)
    expect(guard.exitCode, stderr || stdout).toBe(0)
    const result = JSON.parse(stdout.trim()) as Record<string, unknown>
    expect(result.outer_guard_clean).toBe(true)
    expect(result.outer_guard_rescued_live_fixture).toBe(false)
    const report = result.report as Record<string, unknown>
    expect(report.mode).toBe('prepublish-kill')
    expect(report.owner_record_absent_at_gate).toBe(true)
    expect(report.fixture_alive_at_gate).toBe(true)
    expect(report.creation_identity_source).toBe('subreaper-adopted-child')
    expect(report.helper_exit_signal).toBe(9)
    expect(report.creation_identity_pinned).toBe(true)
    expect(report.group_signal_sent).toBe(true)
    expect(report.group_absent).toBe(true)
    expect(report.reaped_delegate_pid).toBe(true)
    expect(report.cleanup_succeeded).toBe(true)
    expect(fs.existsSync(path.join(home, '.delegate-owner-prepublish.gate'))).toBe(true)
    expect(fs.existsSync(path.join(home, '.delegate-owner-at-spawn.json'))).toBe(false)
  }, 60_000)

  it('kills and reaps a hung wrapper when the outer guard deadline expires', async () => {
    const home = tempHome()
    const guard = spawn(
      'python3',
      [path.resolve(process.cwd(), 'test/helpers/delegate-os-wrapper-timeout-guard.py'),
        process.cwd(), home, '0', '0.2'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DS_AGENT_NODE: process.execPath,
          DS_AGENT_TEST_WRAPPER_CHILD_HANG_MS: '5000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    trackChild(guard)
    let stdout = ''
    let stderr = ''
    guard.stdout?.setEncoding('utf8')
    guard.stderr?.setEncoding('utf8')
    guard.stdout?.on('data', chunk => { stdout += chunk })
    guard.stderr?.on('data', chunk => { stderr += chunk })
    await waitForClose(guard)
    expect(guard.exitCode, stderr || stdout).toBe(1)
    const result = JSON.parse(stdout.trim()) as Record<string, unknown>
    expect(result.wrapper_guard_timed_out).toBe(true)
    expect(result.wrapper_reaped).toBe(true)
    expect(result.wrapper_exit_code).toBe(-9)
    expect(result.outer_guard_clean).toBe(true)
    expect(result.outer_guard_rescued_live_fixture).toBe(false)
  })

  it('cleans supervisor-owned descendants when the wrapper hangs after ownership readiness', async () => {
    const home = tempHome()
    const readyFile = path.join(home, 'supervisor-owned.ready')
    const supervisorReportFile = path.join(home, 'supervisor-report.json')
    fs.writeFileSync(
      path.join(home, 'local-agents.json'),
      JSON.stringify({ agents: [{
        id: 'ipc-hold',
        command: process.execPath,
        args: [path.resolve(process.cwd(), 'test/fixtures/delegate-ipc-hold.mjs'), '{task}'],
        env: ['DS_AGENT_TEST_DELEGATE_PID_FILE', 'DS_AGENT_TEST_FIXTURE_START_DELAY_MS'],
        timeoutMs: 60_000,
      }] }),
    )
    const guard = spawn(
      'python3',
      [path.resolve(process.cwd(), 'test/helpers/delegate-os-wrapper-timeout-guard.py'),
        process.cwd(), home, '0', '0.25', readyFile],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DS_AGENT_NODE: process.execPath,
          DS_AGENT_TEST_SUPERVISOR_HANG_AFTER_OWNERSHIP_MS: '5000',
          DS_AGENT_TEST_SUPERVISOR_OWNERSHIP_READY_FILE: readyFile,
          DS_AGENT_TEST_SUPERVISOR_REPORT_FILE: supervisorReportFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    trackChild(guard)
    let stdout = ''
    let stderr = ''
    guard.stdout?.setEncoding('utf8')
    guard.stderr?.setEncoding('utf8')
    guard.stdout?.on('data', chunk => { stdout += chunk })
    guard.stderr?.on('data', chunk => { stderr += chunk })
    await waitForClose(guard)
    expect(guard.exitCode, stderr || stdout).toBe(1)
    const result = JSON.parse(stdout.trim()) as Record<string, unknown>
    expect(result.wrapper_guard_timed_out).toBe(true)
    expect(result.wrapper_reaped).toBe(true)
    expect(result.wrapper_exit_code).toBe(-9)
    expect(result.supervisor_cleanup_waited).toBe(true)
    expect(result.outer_guard_rescued_live_fixture).toBe(false)
    expect(result.outer_guard_live_rescues).toEqual([])
    expect(result.outer_guard_clean).toBe(true)
    expect(fs.existsSync(readyFile)).toBe(true)
    const report = JSON.parse(fs.readFileSync(supervisorReportFile, 'utf8')) as Record<string, unknown>
    expect(report.failure_kind).toBe('SupervisorInterrupted')
    expect(report.creation_identity_pinned).toBe(true)
    expect(report.group_signal_sent).toBe(true)
    expect(report.group_absent).toBe(true)
    expect(report.reaped_delegate_pid).toBe(true)
    expect(report.cleanup_succeeded).toBe(true)
  }, 60_000)

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

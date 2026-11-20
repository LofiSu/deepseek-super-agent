import { spawn } from 'node:child_process'
import path from 'node:path'

export interface DelegateOsSupervisorReport {
  mode: 'fault' | 'assertion-failure' | 'timeout-failure' | 'wrapper-timeout-probe' | 'prepublish-kill' | 'prepublish-timeout'
  subreaper: boolean
  helper_pid: number | null
  helper_exit_signal: number | null
  delegate_pid: number | null
  delegate_pgid: number | null
  helper_waited: boolean
  group_signal_sent: boolean
  group_absent: boolean
  reaped_pids: number[]
  reaped_delegate_pid: boolean
  failure_kind: string | null
  failure_message: string | null
  cleanup_error: string | null
  expected_failure: boolean
  cleanup_succeeded: boolean
  creation_identity_pinned: boolean
  owner_acknowledged: boolean
  injected_timeout_checkpoint: boolean
  helper_created?: boolean
  unsupported_capability?: string | null
  operational_failure?: string | null
  safe_direct_child_fallback_used?: boolean
}

export class DelegateOsSupervisorError extends Error {
  constructor(message: string, readonly report: DelegateOsSupervisorReport | null) {
    super(message)
    this.name = 'DelegateOsSupervisorError'
  }
}

export function delegateOsSupervisorSupported(platform = process.platform): boolean {
  return platform === 'linux'
}

/** Run the Linux subreaper and await it fully before a test removes its home. */
export async function runDelegateOsSupervisor(
  mode: DelegateOsSupervisorReport['mode'],
  home: string,
  task = 'delegate-crash-probe-task',
  timeoutMs = 60_000,
): Promise<DelegateOsSupervisorReport> {
  if (!delegateOsSupervisorSupported()) {
    throw new Error('delegate OS-fault supervisor requires Linux subreaper support')
  }
  const script = path.resolve(process.cwd(), 'test/helpers/delegate-os-supervisor.py')
  const child = spawn('python3', [script, mode, home, process.cwd(), task, String(process.pid)], {
    cwd: process.cwd(),
    env: { ...process.env, DS_AGENT_NODE: process.execPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', chunk => { stdout += chunk })
  child.stderr?.on('data', chunk => { stderr += chunk })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
  }, timeoutMs)
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  let status: { code: number | null; signal: NodeJS.Signals | null }
  try {
    status = await exit
  } finally {
    clearTimeout(timer)
  }

  let report: DelegateOsSupervisorReport
  try {
    report = JSON.parse(stdout.trim()) as DelegateOsSupervisorReport
  } catch {
    throw new Error(`delegate OS supervisor returned invalid output (exit=${status.code}, signal=${status.signal}): ${stderr || stdout}`)
  }
  if (timedOut || status.code !== 0 || !report.cleanup_succeeded) {
    throw new DelegateOsSupervisorError(
      `delegate OS supervisor failed (exit=${status.code}, signal=${status.signal}): ${JSON.stringify(report)}${stderr ? `; stderr=${stderr}` : ''}`,
      report,
    )
  }
  return report
}

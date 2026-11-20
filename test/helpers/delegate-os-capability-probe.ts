import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface CapabilityProbeResult {
  exitCode: number | null
  stdout: string
  stderr: string
  report: Record<string, unknown> | null
  home: string
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function resolvePython(): string {
  try {
    const executable = execFileSync(
      'python3',
      ['-c', 'import os, sys; print(os.path.realpath(sys.executable))'],
      { encoding: 'utf8' },
    ).trim()
    if (!executable) throw new Error('python3 returned an empty executable path')
    return executable
  } catch (error) {
    throw new Error(
      'Python 3 is required for Linux delegate capability probes; install python3 and ensure it is available on PATH',
      { cause: error },
    )
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`
}

function probeScripts(home: string, python: string): string {
  const injector = path.join(home, 'inject.py')
  fs.writeFileSync(injector, String.raw`
import errno, os, runpy, signal, sys
stage = os.environ.get('DS_AGENT_TEST_CAPABILITY_FAILURE', '')
target = sys.argv[1]
args = sys.argv[2:]
if target.endswith('delegate-os-supervisor.py') or target.endswith('delegate-os-wrapper-timeout-guard.py'):
    base_open = getattr(os, 'pidfd_open', None)
    base_send = getattr(signal, 'pidfd_send_signal', None)
    def fail(code, api):
        def unavailable(*_args, **_kwargs):
            raise OSError(code, 'injected ' + api + ' capability failure')
        return unavailable
    if stage == 'missing_open':
        if hasattr(os, 'pidfd_open'): del os.pidfd_open
    elif stage == 'missing_signal':
        if hasattr(signal, 'pidfd_send_signal'): del signal.pidfd_send_signal
    elif stage in ('open_enosys', 'permission_open'):
        os.pidfd_open = fail(errno.ENOSYS if stage == 'open_enosys' else errno.EPERM, 'pidfd_open')
    elif stage in ('signal_enosys', 'permission_signal'):
        signal.pidfd_send_signal = fail(errno.ENOSYS if stage == 'signal_enosys' else errno.EPERM, 'pidfd_send_signal')
    elif stage == 'open_late':
        calls = [0]
        def late_open(*args, **kwargs):
            calls[0] += 1
            if calls[0] >= 2: return fail(errno.ENOSYS, 'late pidfd_open')(*args, **kwargs)
            return base_open(*args, **kwargs)
        os.pidfd_open = late_open
    elif stage == 'signal_late':
        def late_send(pidfd, sig, *args, **kwargs):
            if sig != 0: return fail(errno.ENOSYS, 'late pidfd_send_signal')(pidfd, sig, *args, **kwargs)
            return base_send(pidfd, sig, *args, **kwargs)
        signal.pidfd_send_signal = late_send
with open(os.path.join(os.environ['HOME'], 'probe-env.json'), 'w', encoding='utf8') as audit:
    import json
    json.dump({'home': os.environ.get('HOME'), 'node_options': os.environ.get('NODE_OPTIONS'),
               'api_key': os.environ.get('DS_AGENT_API_KEY')}, audit)
sys.argv = [target, *args]
runpy.run_path(target, run_name='__main__')
`)
  const shim = path.join(home, 'bin')
  fs.mkdirSync(shim)
  const executable = path.join(shim, 'python3')
  fs.writeFileSync(executable, `#!/bin/sh\nexec ${shellQuote(python)} ${shellQuote(injector)} "$@"\n`)
  fs.chmodSync(executable, 0o700)
  return shim
}

export async function runDelegateCapabilityProbe(
  stage: string,
  target: 'supervisor' | 'outer-guard' = 'supervisor',
): Promise<CapabilityProbeResult> {
  if (process.platform !== 'linux') {
    throw new Error('delegate capability probes require Linux')
  }
  const python = resolvePython()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-capability-test-'))
  const shim = probeScripts(home, python)
  const fixture = path.join(repo, 'test/fixtures/delegate-ipc-hold.mjs')
  fs.writeFileSync(path.join(home, 'local-agents.json'), JSON.stringify({ agents: [{
    id: 'ipc-hold', command: process.execPath, args: [fixture, '{task}'],
    env: ['DS_AGENT_TEST_DELEGATE_PID_FILE'], timeoutMs: 60_000,
  }] }))
  const reportFile = path.join(home, 'supervisor-report.json')
  const helperMarker = path.join(home, 'helper-launch-attempted')
  const env = {
    PATH: `${shim}:${process.env.PATH ?? ''}`,
    HOME: home,
    TMPDIR: os.tmpdir(),
    CI: 'true',
    DS_AGENT_ALLOW_MOCK_FIXTURE: '1',
    NODE_NO_WARNINGS: '1',
    DS_AGENT_NODE: process.execPath,
    COREPACK_HOME: '/usr/local/share/corepack',
    COREPACK_DEFAULT_TO_LATEST: '0',
    DS_AGENT_TEST_CAPABILITY_FAILURE: stage,
    DS_AGENT_TEST_SUPERVISOR_REPORT_FILE: reportFile,
    DS_AGENT_TEST_HELPER_LAUNCH_MARKER: helperMarker,
  }
  const guard = path.resolve(repo, 'test/helpers/delegate-os-wrapper-timeout-guard.py')
  const command = target === 'outer-guard' ? path.join(shim, 'python3') : python
  const args = target === 'outer-guard'
    ? [guard, repo, home, '0']
    : [guard, repo, home, '0']
  const child = spawn(command, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', chunk => { stdout += chunk })
  child.stderr?.on('data', chunk => { stderr += chunk })
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => resolve(code))
  })
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
  let report: Record<string, unknown> | null = null
  if (lines.length) {
    try { report = JSON.parse(lines.at(-1)!) as Record<string, unknown> } catch { /* reported as null */ }
  }
  if (target === 'supervisor' && fs.existsSync(reportFile)) {
    try { report = { ...report, supervisor_report: JSON.parse(fs.readFileSync(reportFile, 'utf8')) as Record<string, unknown> } }
    catch { /* keep the wrapper result for diagnostic assertions */ }
  }
  return { exitCode, stdout, stderr, report, home }
}

import { runDelegateOsSupervisor } from './delegate-os-supervisor.ts'

const home = process.argv[2]
if (!home) throw new Error('missing isolated test home')

const injectedHangMs = Number(process.env.DS_AGENT_TEST_WRAPPER_CHILD_HANG_MS ?? 0)
if (Number.isFinite(injectedHangMs) && injectedHangMs > 0) {
  await new Promise(resolve => setTimeout(resolve, injectedHangMs))
}

try {
  const mode = process.env.DS_AGENT_TEST_SUPERVISOR_MODE === 'prepublish-kill'
    ? 'prepublish-kill'
    : process.env.DS_AGENT_TEST_SUPERVISOR_MODE === 'prepublish-timeout'
      ? 'prepublish-timeout'
      : 'wrapper-timeout-probe'
  const report = await runDelegateOsSupervisor(mode, home, 'pre-pid-timeout', 1_500)
  process.stdout.write(`${JSON.stringify({ wrapperRejected: false, report })}\n`)
  if (mode !== 'prepublish-kill' || !report.cleanup_succeeded) process.exitCode = 1
} catch (error) {
  const report = typeof error === 'object' && error !== null && 'report' in error
    ? (error as { report: unknown }).report
    : null
  process.stdout.write(`${JSON.stringify({
    wrapperRejected: true,
    errorName: error instanceof Error ? error.name : typeof error,
    report,
  })}\n`)
}

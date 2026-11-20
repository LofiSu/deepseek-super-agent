import { runDelegateOsSupervisor } from './delegate-os-supervisor.ts'

const home = process.argv[2]
if (!home) throw new Error('missing isolated test home')

try {
  await runDelegateOsSupervisor('wrapper-timeout-probe', home, 'pre-pid-timeout', 1_500)
  process.stdout.write(`${JSON.stringify({ wrapperRejected: false })}\n`)
  process.exitCode = 1
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

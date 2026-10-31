import { describe, expect, it } from 'vitest'
import { runParallelDemo } from '../src/cli/demos/parallel.ts'
import { runSpillMemoryDemo } from '../src/cli/demos/spill-memory.ts'
import { runWatchdogDemo } from '../src/cli/demos/watchdog.ts'

/**
 * Opt-in integration suite. It creates real issues/comments on
 * DS_AGENT_GH_REPO and needs a live model + authenticated gh CLI:
 *
 *   pnpm test:demo:real
 *
 * The default `pnpm test` suite does not touch the network or the repository.
 */
const enabled = process.env.DS_AGENT_REAL_CHANNELS === '1'

describe.skipIf(!enabled)('real-channel demos (opt-in)', () => {
  it('parallel: three real GitHub issues run three live workers', async () => {
    const summary = await runParallelDemo()
    expect(summary.ok).toBe(true)
    expect(summary.snapshot.tickets).toHaveLength(3)
    expect(summary.checks.every(check => check.ok)).toBe(true)
  }, 600_000)

  it('spill: real GitHub issue thread creates two spills and a live read_object recall', async () => {
    const summary = await runSpillMemoryDemo()
    expect(summary.ok).toBe(true)
    expect(summary.snapshot.tickets).toHaveLength(1)
    expect(summary.snapshot.outbox.some(row => row.channel === 'github' && row.status === 'sent')).toBe(true)
  }, 600_000)

  it('watchdog: real GitHub issue triggers nudge then fail', async () => {
    const summary = await runWatchdogDemo()
    expect(summary.ok).toBe(true)
    expect(summary.snapshot.events.some(event => event.type === 'watchdog.nudge')).toBe(true)
    expect(summary.snapshot.events.some(event => event.type === 'watchdog.fail')).toBe(true)
  }, 600_000)
})

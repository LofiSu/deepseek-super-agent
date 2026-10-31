import { describe, expect, it } from 'vitest'
import { Daemon } from '../src/harness/daemon.ts'
import { MachineRegistry } from '../src/harness/machines.ts'
import { freshRuntime, shutdown } from './fixtures.ts'

describe('T40 machines + watchdog idle', () => {
  it('registers heartbeats and resumes hands without session in daemon', () => {
    const machines = new MachineRegistry()
    machines.register('mac-1', ['bash', 'fs'])
    machines.markOffline('mac-1')
    expect(machines.get('mac-1')?.status).toBe('offline')
    const hb = machines.heartbeat('mac-1')
    expect(hb.status).toBe('online')
    expect(hb.resumed).toBe(true)
    expect(machines.pickHands('t1', ['bash'])?.id).toBe('mac-1')

    const lines: string[] = []
    let ticks = 0
    const daemon = new Daemon({ tick: () => { ticks += 1 }, intervalMs: 60_000 }, line => lines.push(line), machines)
    daemon.onMachineResume('mac-1')
    daemon.tick()
    expect(lines.some(l => l.includes('resume'))).toBe(true)
    expect(ticks).toBe(1)
    daemon.stop()
  })

  it('watchdog idle increments when nothing is stuck', async () => {
    const runtime = freshRuntime({ stuckMs: 60_000, watchdogIntervalMs: 60_000 })
    runtime.watchdog.tick()
    const snap = runtime.metrics.snapshot()
    expect(snap.counters['watchdog.idle']).toBeGreaterThanOrEqual(1)
    expect(snap.counters['watchdog.nudge']).toBe(0)
    await shutdown(runtime)
  })
})

import { describe, expect, it } from 'vitest'
import { Daemon } from '../src/harness/daemon.ts'
import { MachineRegistry } from '../src/harness/machines.ts'
import { freshRuntime, shutdown } from './fixtures.ts'

describe('T40 machines + watchdog idle', () => {
  it('uses the configured stale interval while leaving the default unbounded', () => {
    const previous = process.env.DS_AGENT_MACHINE_STALE_MS
    try {
      delete process.env.DS_AGENT_MACHINE_STALE_MS
      const defaultRegistry = new MachineRegistry()
      defaultRegistry.register('default')
      expect(defaultRegistry.markStaleOffline(Date.now() + 1_000_000)).toHaveLength(0)
      process.env.DS_AGENT_MACHINE_STALE_MS = '1000'
      const configured = new MachineRegistry()
      configured.register('configured')
      expect(configured.markStaleOffline(Date.now() + 1001)).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.DS_AGENT_MACHINE_STALE_MS
      else process.env.DS_AGENT_MACHINE_STALE_MS = previous
    }
  })
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

  it('expires stale machines before daemon offline decisions and resumes through a hook', () => {
    const machines = new MachineRegistry(1000)
    machines.register('mac-1')
    const lines: string[] = []
    const resumed: string[] = []
    const daemon = new Daemon({ tick: () => {}, intervalMs: 1000 }, line => lines.push(line), machines, id => resumed.push(id))
    daemon.tick(Date.now() + 1001)
    expect(machines.get('mac-1')?.status).toBe('offline')
    expect(lines).toContain('[daemon] all hands offline; brain continues from Store only')
    expect(machines.heartbeat('mac-1').resumed).toBe(true)
    daemon.onMachineResume('mac-1')
    expect(resumed).toEqual(['mac-1'])
  })
})

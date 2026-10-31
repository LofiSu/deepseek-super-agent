import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MachineRegistry } from '../src/harness/machines.ts'
import { healthProbe } from '../src/watchdog/health.ts'
import { Store } from '../src/store/sqlite.ts'
import { tempHome } from './fixtures.ts'

describe('health probe', () => {
  it('reports store, vault mode, online machines, and watchdog idle without secrets', () => {
    const home = tempHome()
    const store = new Store(home)
    const machines = new MachineRegistry()
    machines.register('m1')
    machines.register('m2')
    machines.markOffline('m2')
    fs.writeFileSync(path.join(home, 'vault.json'), '{"TOKEN":"hidden-value"}', { mode: 0o600 })
    const result = healthProbe(store, home, machines)
    expect(result).toEqual({ store: 'ok', vaultMode: 'ok', machinesOnline: 1, watchdogIdle: true })
    expect(JSON.stringify(result)).not.toContain('hidden-value')
    store.close()
  })
})

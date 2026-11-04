import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MachineRegistry } from '../src/harness/machines.ts'
import { healthProbe, type CapabilityState } from '../src/watchdog/health.ts'
import { LATEST_SCHEMA_VERSION } from '../src/store/schema.ts'
import { Store } from '../src/store/sqlite.ts'
import { tempHome } from './fixtures.ts'

const READ_ISOLATION = 'DS_AGENT_SANDBOX_READ_ISOLATION'
let previousReadIsolation: string | undefined

describe('health probe', () => {
  beforeEach(() => {
    previousReadIsolation = process.env[READ_ISOLATION]
    delete process.env[READ_ISOLATION]
  })

  afterEach(() => {
    if (previousReadIsolation === undefined) delete process.env[READ_ISOLATION]
    else process.env[READ_ISOLATION] = previousReadIsolation
  })

  it('reports store, vault mode, online machines, and watchdog idle without secrets', () => {
    const home = tempHome()
    const store = new Store(home)
    try {
      const machines = new MachineRegistry()
      machines.register('m1')
      machines.register('m2')
      machines.markOffline('m2')
      fs.writeFileSync(path.join(home, 'vault.json'), '{"TOKEN":"hidden-value"}', { mode: 0o600 })
      const result = healthProbe(store, home, machines)
      // The four original fields keep their existing values and types.
      expect(result).toMatchObject({
        store: 'ok',
        vaultMode: 'ok',
        machinesOnline: 1,
        watchdogIdle: true,
      })
      expect(result.capabilities.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
      expect(LATEST_SCHEMA_VERSION).toBe(3)
      expect(result.capabilities.readIsolation).toEqual({ requested: 'off', enforced: 'unknown' })
      expect(result.capabilities.workerSandbox).toEqual({ requested: 'on', enforced: 'unknown' })
      expect(result.capabilities.a2aTransport).toBe('in-process')
      expect(result.capabilities.meshTransport).toBe('in-process')
      expect(JSON.stringify(result)).not.toContain('hidden-value')
    } finally {
      store.close()
    }
  })

  it('reports a closed store as an error with an unknown schema and never throws', () => {
    const home = tempHome()
    const store = new Store(home)
    store.close()
    let result: ReturnType<typeof healthProbe>
    expect(() => {
      result = healthProbe(store, home)
    }).not.toThrow()
    expect(result!.store).toBe('error')
    expect(result!.capabilities.schemaVersion).toBe('unknown')
    // Fail closed: a store read failure must not claim the watchdog is idle.
    expect(result!.watchdogIdle).toBe(false)
    expect(() => JSON.stringify(result!)).not.toThrow()
  })

  const isolationCases: Array<[string | undefined, CapabilityState]> = [
    [undefined, 'off'],
    ['', 'off'],
    ['0', 'off'],
    ['false', 'off'],
    ['1', 'on'],
    ['true', 'on'],
    ['strict', 'on'],
    ['not-a-valid-value', 'unknown'],
  ]

  it.each(isolationCases)('maps read isolation env %j to %s', (raw, expected) => {
    if (raw === undefined) delete process.env[READ_ISOLATION]
    else process.env[READ_ISOLATION] = raw
    const home = tempHome()
    const store = new Store(home)
    try {
      let result: ReturnType<typeof healthProbe> | undefined
      expect(() => {
        result = healthProbe(store, home)
      }).not.toThrow()
      expect(result!.capabilities.readIsolation.requested).toBe(expected)
      expect(result!.capabilities.readIsolation.enforced).toBe('unknown')
    } finally {
      store.close()
    }
  })

  it('never serializes secret values from env or vault', () => {
    const home = tempHome()
    const store = new Store(home)
    const previousKey = process.env.DS_AGENT_API_KEY
    const envSecret = 'health-env-sentinel-2f6b'
    const vaultSecret = 'health-vault-sentinel-9c1d'
    try {
      process.env.DS_AGENT_API_KEY = envSecret
      fs.writeFileSync(path.join(home, 'vault.json'), JSON.stringify({ TOKEN: vaultSecret }), { mode: 0o600 })
      const serialized = JSON.stringify(healthProbe(store, home))
      expect(serialized).not.toContain(envSecret)
      expect(serialized).not.toContain(vaultSecret)
    } finally {
      if (previousKey === undefined) delete process.env.DS_AGENT_API_KEY
      else process.env.DS_AGENT_API_KEY = previousKey
      store.close()
    }
  })

  it('returns a JSON-stable capability view with in-process transports only', () => {
    const home = tempHome()
    const store = new Store(home)
    try {
      const result = healthProbe(store, home)
      expect(JSON.parse(JSON.stringify(result))).toEqual(result)
      expect(Object.keys(result.capabilities)).toEqual([
        'schemaVersion',
        'readIsolation',
        'workerSandbox',
        'a2aTransport',
        'meshTransport',
      ])
      expect(JSON.stringify(result)).not.toContain('"http"')
    } finally {
      store.close()
    }
  })
})

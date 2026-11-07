import { describe, expect, it } from 'vitest'
import { healthProbe } from '../src/watchdog/health.ts'
import { probeSandboxAvailability, type SandboxSystem } from '../src/env/seccomp.ts'
import { Store } from '../src/store/sqlite.ts'
import { tempHome } from './fixtures.ts'

const linuxWithBwrap: SandboxSystem = {
  platform: 'linux',
  available: bin => bin === 'bwrap',
}

const linuxNoWrap: SandboxSystem = {
  platform: 'linux',
  available: () => false,
}

const darwinWithExec: SandboxSystem = {
  platform: 'darwin',
  available: bin => bin === 'sandbox-exec',
}

describe('probeSandboxAvailability (M2 env)', () => {
  it('reports wrapper available when the platform binary is on PATH', () => {
    expect(probeSandboxAvailability({}, linuxWithBwrap)).toEqual({
      workerSandboxWrapper: 'available',
      strictReadIsolationPolicy: 'off',
    })
    expect(probeSandboxAvailability({}, darwinWithExec)).toEqual({
      workerSandboxWrapper: 'available',
      strictReadIsolationPolicy: 'off',
    })
  })

  it('reports unavailable when the wrapper is missing, not as isolation off', () => {
    expect(probeSandboxAvailability({}, linuxNoWrap)).toEqual({
      workerSandboxWrapper: 'unavailable',
      strictReadIsolationPolicy: 'off',
    })
  })

  it('maps strict read env to strictReadIsolationPolicy when env is valid', () => {
    expect(probeSandboxAvailability(
      { DS_AGENT_SANDBOX_READ_ISOLATION: '1' },
      linuxWithBwrap,
    )).toEqual({
      workerSandboxWrapper: 'available',
      strictReadIsolationPolicy: 'on',
    })
    expect(probeSandboxAvailability(
      { DS_AGENT_SANDBOX_READ_ISOLATION: '0' },
      linuxWithBwrap,
    )).toEqual({
      workerSandboxWrapper: 'available',
      strictReadIsolationPolicy: 'off',
    })
  })

  it('fails closed on invalid read isolation env for policy only', () => {
    expect(probeSandboxAvailability(
      { DS_AGENT_SANDBOX_READ_ISOLATION: 'lax' },
      linuxWithBwrap,
    )).toEqual({
      workerSandboxWrapper: 'available',
      strictReadIsolationPolicy: 'unknown',
    })
  })

  it('reports unsupported on platforms without a filesystem sandbox wrapper', () => {
    expect(probeSandboxAvailability(
      { DS_AGENT_SANDBOX_READ_ISOLATION: 'strict' },
      { platform: 'win32', available: () => true },
    )).toEqual({
      workerSandboxWrapper: 'unsupported',
      strictReadIsolationPolicy: 'on',
    })
  })

  it('keeps wrapper availability independent of whether bwrap would block namespaces', () => {
    // Presence on PATH must not be conflated with enforcement proof.
    expect(probeSandboxAvailability({}, linuxWithBwrap).workerSandboxWrapper).toBe('available')
  })
})

describe('healthProbe sandbox diagnostic (M10 watchdog)', () => {
  it('never sets capabilities.enforced from wrapper presence', () => {
    const home = tempHome()
    const store = new Store(home)
    try {
      const result = healthProbe(store, home)
      expect(result.capabilities.readIsolation.enforced).toBe('unknown')
      expect(result.capabilities.workerSandbox.enforced).toBe('unknown')
      expect(result.capabilities.sandboxAvailability).toEqual(probeSandboxAvailability(process.env))
      expect(result.capabilities.sandboxAvailability).not.toHaveProperty('enforced')
    } finally {
      store.close()
    }
  })

  if (process.platform === 'linux' && probeSandboxAvailability({}).workerSandboxWrapper === 'available') {
    it('exposes live wrapper availability without claiming enforcement', () => {
      const home = tempHome()
      const store = new Store(home)
      try {
        const result = healthProbe(store, home)
        expect(result.capabilities.workerSandbox.enforced).toBe('unknown')
        expect(result.capabilities.sandboxAvailability.workerSandboxWrapper).toBe('available')
      } finally {
        store.close()
      }
    })
  }
})

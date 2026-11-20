import { describe, expect, it } from 'vitest'
import { delegateOsSupervisorSupported } from './helpers/delegate-os-supervisor.ts'

describe('delegate OS fault suite platform capability', () => {
  it('runs only with Linux subreaper support and skips on other platforms', () => {
    expect(delegateOsSupervisorSupported('linux')).toBe(true)
    expect(delegateOsSupervisorSupported('darwin')).toBe(false)
    expect(delegateOsSupervisorSupported('win32')).toBe(false)
    expect(delegateOsSupervisorSupported('freebsd')).toBe(false)
  })
})

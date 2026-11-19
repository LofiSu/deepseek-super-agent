import { describe, expect, it } from 'vitest'
import { UserError } from '../src/shared/errors.ts'
import {
  BASH_TIMEOUT_MAX_MS,
  BASH_TIMEOUT_MIN_MS,
  BASH_TIMEOUT_SERVE_DEFAULT_MS,
  parseBashTimeoutMs,
} from '../src/env/bash-timeout.ts'

describe('parseBashTimeoutMs', () => {
  it('uses serve default when unset', () => {
    expect(parseBashTimeoutMs({})).toBe(BASH_TIMEOUT_SERVE_DEFAULT_MS)
  })

  it('honors env override', () => {
    expect(parseBashTimeoutMs({ DS_AGENT_BASH_TIMEOUT_MS: '120000' })).toBe(120_000)
  })

  it('fails on garbage', () => {
    expect(() => parseBashTimeoutMs({ DS_AGENT_BASH_TIMEOUT_MS: 'nope' })).toThrow(UserError)
    expect(() => parseBashTimeoutMs({ DS_AGENT_BASH_TIMEOUT_MS: '1.5' })).toThrow(UserError)
  })

  it('clamps range', () => {
    expect(() => parseBashTimeoutMs({ DS_AGENT_BASH_TIMEOUT_MS: String(BASH_TIMEOUT_MIN_MS - 1) })).toThrow(UserError)
    expect(() => parseBashTimeoutMs({ DS_AGENT_BASH_TIMEOUT_MS: String(BASH_TIMEOUT_MAX_MS + 1) })).toThrow(UserError)
  })
})

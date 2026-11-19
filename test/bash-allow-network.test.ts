import { describe, expect, it } from 'vitest'
import { parseBashAllowNetwork } from '../src/env/bash-allow-network.ts'
import { UserError } from '../src/shared/errors.ts'

describe('parseBashAllowNetwork', () => {
  it('defaults to false when unset', () => {
    expect(parseBashAllowNetwork({})).toBe(false)
  })

  it.each(['0', 'false', ''])('treats %s as false', raw => {
    expect(parseBashAllowNetwork({ DS_AGENT_BASH_ALLOW_NETWORK: raw })).toBe(false)
  })

  it.each(['1', 'true'])('treats %s as true', raw => {
    expect(parseBashAllowNetwork({ DS_AGENT_BASH_ALLOW_NETWORK: raw })).toBe(true)
  })

  it('rejects garbage', () => {
    expect(() => parseBashAllowNetwork({ DS_AGENT_BASH_ALLOW_NETWORK: 'maybe' })).toThrow(UserError)
  })
})

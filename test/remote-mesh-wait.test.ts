import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_REMOTE_RESULT_TIMEOUT_MS,
  MAX_REMOTE_RESULT_TIMEOUT_MS,
  RemoteMeshResultWait,
  remoteResultTimeoutMsFromEnv,
} from '../src/harness/remote-mesh-wait.ts'

describe('remoteResultTimeoutMsFromEnv', () => {
  it('uses override when finite', () => {
    expect(remoteResultTimeoutMsFromEnv({}, 500)).toBe(500)
  })

  it('parses env', () => {
    expect(remoteResultTimeoutMsFromEnv({ DS_AGENT_REMOTE_RESULT_TIMEOUT_MS: '1200' })).toBe(1200)
  })

  it('clamps an oversized override to the Node timer max', () => {
    expect(remoteResultTimeoutMsFromEnv({}, 3_000_000_000)).toBe(MAX_REMOTE_RESULT_TIMEOUT_MS)
  })

  it('clamps an oversized env value to the Node timer max', () => {
    expect(
      remoteResultTimeoutMsFromEnv({ DS_AGENT_REMOTE_RESULT_TIMEOUT_MS: '3000000000' }),
    ).toBe(MAX_REMOTE_RESULT_TIMEOUT_MS)
  })

  it('falls back to the default for invalid values', () => {
    expect(remoteResultTimeoutMsFromEnv({})).toBe(DEFAULT_REMOTE_RESULT_TIMEOUT_MS)
    expect(remoteResultTimeoutMsFromEnv({}, -1)).toBe(DEFAULT_REMOTE_RESULT_TIMEOUT_MS)
    expect(remoteResultTimeoutMsFromEnv({}, Number.NaN)).toBe(DEFAULT_REMOTE_RESULT_TIMEOUT_MS)
    expect(
      remoteResultTimeoutMsFromEnv({ DS_AGENT_REMOTE_RESULT_TIMEOUT_MS: '-5' }),
    ).toBe(DEFAULT_REMOTE_RESULT_TIMEOUT_MS)
  })

  it('keeps zero as disabled', () => {
    expect(remoteResultTimeoutMsFromEnv({}, 0)).toBe(0)
    expect(remoteResultTimeoutMsFromEnv({ DS_AGENT_REMOTE_RESULT_TIMEOUT_MS: '0' })).toBe(0)
  })
})

describe('RemoteMeshResultWait', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('fires onTimeout after arm and clears on clear', () => {
    vi.useFakeTimers()
    const hits: string[] = []
    const wait = new RemoteMeshResultWait(1_000, (ticketId, assignmentId) => {
      hits.push(`${ticketId}:${assignmentId}`)
    })
    wait.arm('t1', 'asg_1')
    wait.clear('t1')
    vi.advanceTimersByTime(5_000)
    expect(hits).toEqual([])
  })

  it('invokes onTimeout when not cleared', () => {
    vi.useFakeTimers()
    const hits: string[] = []
    const wait = new RemoteMeshResultWait(500, (ticketId, assignmentId) => {
      hits.push(`${ticketId}:${assignmentId}`)
    })
    wait.arm('t2', 'asg_2')
    vi.advanceTimersByTime(500)
    expect(hits).toEqual(['t2:asg_2'])
  })

  it('does not overflow to a 1 ms timer for oversized timeouts', () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const hits: string[] = []
    const wait = new RemoteMeshResultWait(3_000_000_000, (ticketId, assignmentId) => {
      hits.push(`${ticketId}:${assignmentId}`)
    })
    wait.arm('t3', 'asg_3')

    const delay = setTimeoutSpy.mock.calls[0]?.[1]
    expect(typeof delay).toBe('number')
    expect(delay).toBeLessThanOrEqual(MAX_REMOTE_RESULT_TIMEOUT_MS)
    expect(delay).toBeGreaterThan(1_000)

    vi.advanceTimersByTime(10_000)
    expect(hits).toEqual([])
    wait.clearAll()
  })

  it('does not arm a timer when timeout is zero', () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const hits: string[] = []
    const wait = new RemoteMeshResultWait(0, (ticketId, assignmentId) => {
      hits.push(`${ticketId}:${assignmentId}`)
    })
    wait.arm('t4', 'asg_4')
    expect(setTimeoutSpy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10_000)
    expect(hits).toEqual([])
  })
})

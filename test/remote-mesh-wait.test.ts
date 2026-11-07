import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteMeshResultWait, remoteResultTimeoutMsFromEnv } from '../src/harness/remote-mesh-wait.ts'

describe('remoteResultTimeoutMsFromEnv', () => {
  it('uses override when finite', () => {
    expect(remoteResultTimeoutMsFromEnv({}, 500)).toBe(500)
  })

  it('parses env', () => {
    expect(remoteResultTimeoutMsFromEnv({ DS_AGENT_REMOTE_RESULT_TIMEOUT_MS: '1200' })).toBe(1200)
  })
})

describe('RemoteMeshResultWait', () => {
  afterEach(() => {
    vi.useRealTimers()
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
})

import { afterEach, describe, expect, it } from 'vitest'
import type { SessionJournal } from '../src/harness/session.ts'
import type { Metrics } from '../src/metrics/metrics.ts'
import type { Ticket } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'
import { Watchdog, type WatchdogControl } from '../src/watchdog/watchdog.ts'
import { tempHome } from './fixtures.ts'

const open: Store[] = []

afterEach(() => {
  for (const store of open.splice(0)) {
    if (store.isOpen) store.close()
  }
})

describe('watchdog failure origin', () => {
  it('routes a stuck assignment through watchdogFail instead of a worker report', () => {
    const store = new Store(tempHome())
    open.push(store)
    store.putDoc('ticket', 'ticket_1', {
      id: 'ticket_1',
      title: 'stuck',
      brief: 'stuck',
      assignments: [{ id: 'asg_1', state: 'running', startedAt: '2026-01-01T00:00:00.000Z' }],
    } as unknown as Ticket)
    store.completeJob(store.createJob({ sessionId: 'worker_ticket_1', ticketId: 'ticket_1', name: 'a' }).id, 'failed')
    store.completeJob(store.createJob({ sessionId: 'worker_ticket_1', ticketId: 'ticket_1', name: 'b' }).id, 'failed')

    const calls: { ticketId: string; reason: string }[] = []
    const engine: WatchdogControl = {
      watchdogFail: (ticketId, reason) => {
        calls.push({ ticketId, reason })
        return { surfaced: false, verdict: 'hold' }
      },
    }
    const watchdog = new Watchdog({
      store,
      engine,
      journal: {} as unknown as SessionJournal,
      log: () => {},
      metrics: { increment: () => {} } as unknown as Metrics,
      intervalMs: 60_000,
      stuckMs: 60_000,
      now: () => Date.now(),
    })

    watchdog.tick()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.ticketId).toBe('ticket_1')
    expect(store.listEvents().some(event => event.type === 'watchdog.fail')).toBe(true)
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import type { Runtime } from '../src/runtime.ts'
import type { SessionRow, Ticket } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'
import { goalDrift, Watchdog } from '../src/watchdog/watchdog.ts'
import { freshRuntime, shutdown, tempHome } from './fixtures.ts'

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

const now = Date.parse('2026-10-31T00:00:00.000Z')

function worker(id: string, ticketId: string, heartbeat: string, status: SessionRow['status'] = 'running'): SessionRow {
  return {
    id,
    role: 'worker',
    ticketId,
    status,
    heartbeat,
    createdAt: heartbeat,
  }
}

function ticket(id: string, report: string, speculative = false): Ticket {
  return {
    id,
    title: 'login timeout',
    brief: 'login timeout',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-v1',
      scope: 'login timeout',
      actor: { source: 'im', id: 'alex' },
      basis: 'addressed',
    },
    threadKeys: ['im:topic'],
    channels: [],
    inputs: [],
    assignments: [{
      id: 'asg_1',
      state: 'running',
      speculative,
      report: { kind: 'progress', text: report },
    }],
    speculative,
    originTriggerId: 'trg',
    createdAt: '2026-10-31T00:00:00.000Z',
  }
}

describe('watchdog', () => {
  it('treats an off-scope report as drift and an on-scope report as aligned', () => {
    expect(goalDrift('login timeout', 'organizing lunch plans for the team')).toBe(true)
    expect(goalDrift('login timeout', 'still chasing the login path')).toBe(false)
    expect(goalDrift('on', 'whatever happened')).toBe(false)
    expect(goalDrift('login timeout', '   ')).toBe(false)
  })

  it('nudges a stuck worker three times, then fails once', () => {
    const store = new Store(tempHome())
    const lines: string[] = []
    const injected: string[] = []
    const failed: string[] = []
    store.upsertSession(worker('worker_ticket_1', 'ticket_1', '2026-10-30T00:00:00.000Z'))
    store.upsertSession({
      id: 'router',
      role: 'router',
      status: 'running',
      heartbeat: '2020-01-01T00:00:00.000Z',
      createdAt: '2020-01-01T00:00:00.000Z',
    })
    const watchdog = new Watchdog({
      store,
      log: line => lines.push(line),
      intervalMs: 1,
      stuckMs: 60_000,
      nudgeEveryMs: 0,
      failAfter: 3,
      now: () => now,
      inject: (session, note) => {
        if (!session.id) return
        injected.push(note)
      },
      failAssignment: session => failed.push(session.id),
    })
    try {
      watchdog.tick()
      watchdog.tick()
      watchdog.tick()
      expect(injected).toEqual([
        'nudge n=1 reason=stuck',
        'nudge n=2 reason=stuck',
        'nudge n=3 reason=stuck',
      ])
      expect(failed).toEqual([])
      watchdog.tick()
      expect(failed).toEqual(['worker_ticket_1'])
      expect(lines.join('\n')).toContain('[watchdog] fail session=worker_ticket_1 ticketId=ticket_1 reason=stuck after 3 nudges')
      watchdog.tick()
      expect(failed).toEqual(['worker_ticket_1'])
    } finally {
      store.close()
    }
  })

  it('waits out the nudge gap, logs infra faults, and nudges scope drift', () => {
    const store = new Store(tempHome())
    const lines: string[] = []
    const injected: string[] = []
    store.putDoc('ticket', 'ticket_9', ticket('ticket_9', 'organizing lunch plans for the team'))
    store.putDoc('ticket', 'ticket_hidden', ticket('ticket_hidden', 'organizing lunch plans', true))
    store.upsertSession(worker('worker_ticket_9', 'ticket_9', '2026-10-31T00:00:00.000Z'))
    const watchdog = new Watchdog({
      store,
      log: line => lines.push(line),
      intervalMs: 1,
      stuckMs: 60_000,
      nudgeEveryMs: 5_000,
      now: () => now,
      inject: (session, note) => {
        if (!session.id) return
        injected.push(note)
      },
    })
    try {
      watchdog.tick()
      watchdog.tick()
      expect(injected).toEqual(['nudge n=1 reason=drift'])
      expect(lines.filter(line => line.includes('[watchdog] drift ticketId=ticket_9'))).toHaveLength(2)
      expect(lines.join('\n')).not.toContain('ticketId=ticket_hidden')
    } finally {
      store.close()
    }

    const faultLines: string[] = []
    const faultStore = new Store(tempHome())
    const faulted = new Watchdog({
      store: faultStore,
      log: line => faultLines.push(line),
      intervalMs: 1,
      stuckMs: 1,
      health: () => { throw new Error('sqlite down') },
    })
    try {
      faulted.tick()
      expect(faultLines.join('\n')).toContain('[watchdog] infra fault db sqlite down')
      expect(faultLines.join('\n')).toContain('[watchdog] tick db=fault stuck=0 drift=0')
    } finally {
      faultStore.close()
    }
  })

  it('injects a nudge into the session log from the runtime watchdog', () => {
    runtime = freshRuntime({
      stuckMs: 1_000,
      nudgeEveryMs: 0,
      watchNow: () => now,
    })
    runtime.store.upsertSession(worker('worker_ticket_x', 'ticket_missing', '2020-01-01T00:00:00.000Z'))
    runtime.watchdog.tick()
    runtime.watchdog.tick()
    runtime.watchdog.tick()
    runtime.watchdog.tick()
    const text = runtime.log.text()
    expect(text).toContain('[watchdog] nudge session=worker_ticket_x ticketId=ticket_missing n=1')
    expect(text).toContain('[watchdog] fail session=worker_ticket_x')
    expect(text).not.toContain('mark_task_failed')
    expect(runtime.store.listMessages('worker_ticket_x').map(message => message.body).join('\n')).toContain('nudge n=1 reason=stuck')
  })
})

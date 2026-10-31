import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { arbitrateSubscribers, bypassEligible } from '../src/core/intake.ts'
import type { Decision, Disposition, Thread, Ticket, Trigger } from '../src/shared/types.ts'
import type { Runtime } from '../src/runtime.ts'
import { freshRuntime, shutdown } from './fixtures.ts'

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

describe('subscription bypass', () => {
  it('fans a same-thread follow-up out with bypass=subscription and does not open a second ticket', async () => {
    runtime = freshRuntime()
    expect(runtime.ingest(imTrigger({
      id: 'trg_noise',
      thread: 'topic/chatter',
      text: 'lol nice weather today haha',
      addressed: false,
    }))).toBe('filtered')
    expect(runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    expect(runtime.ingest(imTrigger({
      id: 'trg_login_2',
      thread: 'topic/bug-login',
      text: '@ds-agent login still 500, the timeout is back',
    }))).toBe('stored')

    const tickets = runtime.store.listDocs<{ id: string; threadKeys: string[] }>('ticket')
    expect(tickets).toHaveLength(1)
    const ticketId = tickets[0]!.id
    const text = runtime.log.text()
    expect(text).toContain(`bypass=subscription ticketId=${ticketId}`)
    expect(text).toContain('ticketId=')
    const thread = runtime.store.getDoc<Thread>('thread', 'im:topic/bug-login')
    expect(thread?.pending).toEqual([])
    expect(thread?.subscriptions).toEqual([ticketId])
    const accepts = runtime.store.listDocs<Decision>('decision').filter(decision => decision.kind === 'accept')
    expect(accepts).toHaveLength(1)
    await runtime.finish()
  })

  it('reject-non-human: a bot trigger on a subscribed thread does not bypass', async () => {
    runtime = freshRuntime()
    expect(runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    const original = runtime.store.listDocs<Ticket>('ticket')[0]!
    expect(runtime.ingest({
      ...imTrigger({
        id: 'trg_ci',
        thread: 'topic/bug-login',
        text: 'CI failed: login timeout on checkout is still broken',
        addressed: false,
      }),
      human: false,
      actor: { source: 'github', id: 'ci-bot' },
    })).toBe('stored')

    const disposition = runtime.store.getDoc<Disposition>('disposition', 'trg_ci')
    expect(disposition?.fanout).toEqual([])
    expect(runtime.log.text()).not.toContain('bypass=subscription')
    const kept = runtime.store.getDoc<Ticket>('ticket', original.id)
    expect(kept?.inputs.some(input => input.triggerId === 'trg_ci')).toBe(false)
    expect(kept?.ended).toBeUndefined()
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(2)
    await runtime.finish()
  })

  it('reject-ended-mandate: a follow-up does not bypass or resume an ended ticket', async () => {
    runtime = freshRuntime()
    expect(runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    const original = runtime.store.listDocs<Ticket>('ticket')[0]!
    runtime.engine.report(original.id, { kind: 'ready', text: 'fixed', deliver: true })
    expect(runtime.ingest(imTrigger({
      id: 'trg_login_2',
      thread: 'topic/bug-login',
      text: '@ds-agent login still 500, the timeout is back',
    }))).toBe('stored')

    const ended = runtime.store.getDoc<Ticket>('ticket', original.id)
    expect(ended?.ended).toMatchObject({ outcome: 'ready', by: 'executor' })
    expect(ended?.inputs.some(input => input.triggerId === 'trg_login_2')).toBe(false)
    const disposition = runtime.store.getDoc<Disposition>('disposition', 'trg_login_2')
    expect(disposition?.fanout ?? []).not.toContain(original.id)
    expect(runtime.log.text()).not.toContain(`bypass=subscription ticketId=${original.id}`)
    await runtime.finish()
  })

  it('rejects a follow-up when the mandate scope is blank', async () => {
    runtime = freshRuntime()
    expect(runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    const original = runtime.store.listDocs<Ticket>('ticket')[0]!
    original.mandate = { ...original.mandate, scope: '   ' }
    runtime.store.putDoc('ticket', original.id, original)
    expect(runtime.ingest(imTrigger({
      id: 'trg_login_2',
      thread: 'topic/bug-login',
      text: '@ds-agent login still 500, the timeout is back',
    }))).toBe('stored')

    const disposition = runtime.store.getDoc<Disposition>('disposition', 'trg_login_2')
    expect(disposition?.fanout).toEqual([])
    expect(runtime.store.getDoc<Ticket>('ticket', original.id)?.inputs.some(input => input.triggerId === 'trg_login_2')).toBe(false)
    expect(runtime.log.text()).not.toContain('bypass=subscription')
    await runtime.finish()
  })

  it('handback unsubscribes so the next human message goes through Eval', async () => {
    runtime = freshRuntime()
    expect(runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    const ticket = runtime.store.listDocs<Ticket>('ticket')[0]!
    expect(runtime.ingest(imTrigger({
      id: 'trg_login_2',
      thread: 'topic/bug-login',
      text: '@ds-agent login still 500, the timeout is back',
    }))).toBe('stored')
    expect(runtime.log.text()).toContain(`bypass=subscription ticketId=${ticket.id}`)
    expect(runtime.store.getDoc<Thread>('thread', 'im:topic/bug-login')?.subscriptions).toEqual([ticket.id])

    expect(runtime.engine.handback(ticket.id, 'trg_login_2', 'not-our-bug')).toBe(true)
    const thread = runtime.store.getDoc<Thread>('thread', 'im:topic/bug-login')!
    expect(thread.subscriptions).toEqual([])
    expect(thread.pending).toContain('trg_login_2')
    expect(runtime.store.getDoc<Ticket>('ticket', ticket.id)?.threadKeys).not.toContain('im:topic/bug-login')
    expect(runtime.log.text()).toContain('unsubscribed=im:topic/bug-login')
    expect(runtime.store.listEvents().some(event => event.type === 'subscription.removed')).toBe(true)

    // Drain the requeued trigger through Eval (opens a fresh ticket). A later follow-up must not fan out to the old one.
    runtime.engine.evaluateDue()
    const afterHandback = runtime.store.listDocs<Ticket>('ticket').map(item => item.id)
    expect(afterHandback).toContain(ticket.id)
    expect(afterHandback.length).toBeGreaterThan(1)
    expect(runtime.ingest(imTrigger({
      id: 'trg_login_3',
      thread: 'topic/bug-login',
      text: '@ds-agent still broken after handback',
    }))).toBe('stored')
    const disposition = runtime.store.getDoc<Disposition>('disposition', 'trg_login_3')
    expect(disposition?.fanout ?? []).not.toContain(ticket.id)
    expect(runtime.store.getDoc<Ticket>('ticket', ticket.id)?.inputs.some(input => input.triggerId === 'trg_login_3')).toBe(false)
    await runtime.finish()
  })

  it('arbitration: one human follow-up reaches the active subscriber, otherwise the most recent', async () => {
    let clock = Date.parse('2026-10-31T00:00:00.000Z')
    runtime = freshRuntime({ now: () => new Date(clock += 1000).toISOString() })
    expect(runtime.ingest(imTrigger({
      id: 'trg_a',
      thread: 'topic/shared',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    expect(runtime.ingest(imTrigger({
      id: 'trg_b',
      thread: 'topic/other',
      text: '@ds-agent please fix the payment timeout on checkout',
    }))).toBe('stored')
    const tickets = runtime.store.listDocs<Ticket>('ticket')
    const older = tickets.find(item => item.originTriggerId === 'trg_a')
    const newer = tickets.find(item => item.originTriggerId === 'trg_b')
    expect(older).toBeDefined()
    expect(newer).toBeDefined()
    runtime.engine.subscribe(newer!.id, 'im:topic/shared')

    expect(runtime.ingest(imTrigger({
      id: 'trg_recent',
      thread: 'topic/shared',
      text: '@ds-agent login still 500, the timeout is back',
    }))).toBe('stored')
    expect(runtime.store.getDoc<Disposition>('disposition', 'trg_recent')?.fanout).toEqual([newer!.id])
    expect(runtime.log.text()).toContain(`bypass=subscription ticketId=${newer!.id}`)
    expect(runtime.log.text()).not.toContain(`bypass=subscription ticketId=${older!.id}`)
    expect(runtime.store.getDoc<Ticket>('ticket', older!.id)?.inputs.some(input => input.triggerId === 'trg_recent')).toBe(false)

    const bumped = runtime.store.getDoc<Ticket>('ticket', newer!.id)!
    bumped.assignments = bumped.assignments.map(assignment => ({
      ...assignment,
      state: 'ended',
      endedAt: '2026-10-31T00:00:09.000Z',
    }))
    runtime.store.putDoc('ticket', bumped.id, bumped)
    expect(runtime.ingest(imTrigger({
      id: 'trg_active',
      thread: 'topic/shared',
      text: '@ds-agent please fix the login timeout again',
    }))).toBe('stored')
    expect(runtime.store.getDoc<Disposition>('disposition', 'trg_active')?.fanout).toEqual([older!.id])
    expect(runtime.store.getDoc<Ticket>('ticket', newer!.id)?.inputs.some(input => input.triggerId === 'trg_active')).toBe(false)
    await runtime.finish()
  })
})

describe('subscription bypass rules', () => {
  const follow = followUp()

  it('reject-non-human', () => {
    const live = sampleTicket('ticket_1')
    expect(bypassEligible(live, follow)).toBe(true)
    expect(bypassEligible(live, followUp({ human: false, actor: { source: 'github', id: 'ci-bot' } }))).toBe(false)
  })

  it('reject-ended-mandate', () => {
    const live = sampleTicket('ticket_1')
    expect(bypassEligible({
      ...live,
      ended: { at: follow.at, outcome: 'ready', by: 'executor' },
    }, follow)).toBe(false)
    expect(bypassEligible({
      ...live,
      ended: { at: follow.at, outcome: 'stopped', by: 'human' },
    }, follow)).toBe(false)
    expect(bypassEligible({
      ...live,
      mandate: { ...live.mandate, scope: '   ' },
    }, follow)).toBe(false)
  })

  it('arbitration', () => {
    const older = sampleTicket('ticket_old', {
      createdAt: '2026-10-31T00:00:00.000Z',
      assignments: [{ id: 'asg_old', state: 'running', speculative: false, startedAt: '2026-10-31T00:00:01.000Z' }],
    })
    const newerPending = sampleTicket('ticket_new_pending', {
      createdAt: '2026-10-31T00:02:00.000Z',
      assignments: [{ id: 'asg_pending', state: 'pending', speculative: false }],
    })
    const newerRunning = sampleTicket('ticket_new_running', {
      createdAt: '2026-10-31T00:03:00.000Z',
      assignments: [{ id: 'asg_running', state: 'running', speculative: false, startedAt: '2026-10-31T00:03:01.000Z' }],
    })
    const newerEnded = sampleTicket('ticket_new_ended', {
      createdAt: '2026-10-31T00:04:00.000Z',
      assignments: [{
        id: 'asg_ended',
        state: 'ended',
        speculative: false,
        startedAt: '2026-10-31T00:04:01.000Z',
        endedAt: '2026-10-31T00:04:02.000Z',
      }],
    })
    expect(arbitrateSubscribers([older, newerPending])?.id).toBe(older.id)
    expect(arbitrateSubscribers([newerPending, older])?.id).toBe(older.id)
    expect(arbitrateSubscribers([older, newerRunning])?.id).toBe(newerRunning.id)
    expect(arbitrateSubscribers([newerEnded, older])?.id).toBe(older.id)
    expect(arbitrateSubscribers([newerEnded, newerPending])?.id).toBe(newerPending.id)
    expect(arbitrateSubscribers([])).toBeUndefined()
  })
})

function sampleTicket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  const createdAt = overrides.createdAt ?? '2026-10-31T00:00:00.000Z'
  return {
    id,
    title: id,
    brief: 'fix the login timeout',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-v1',
      scope: 'fix the login timeout',
      actor: { source: 'im', id: 'alex' },
      basis: 'addressed',
    },
    threadKeys: ['im:topic/bug-login'],
    channels: [],
    inputs: [],
    assignments: [{ id: `${id}_asg`, state: 'running', speculative: false, startedAt: createdAt }],
    speculative: false,
    originTriggerId: `trg_${id}`,
    createdAt,
    ...overrides,
  }
}

function followUp(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'trg_follow',
    source: 'im',
    threads: [{ source: 'im', id: 'topic/bug-login' }],
    actor: { source: 'im', id: 'alex' },
    human: true,
    at: '2026-10-31T00:05:00.000Z',
    text: '@ds-agent login still 500, the timeout is back',
    meta: {},
    ...overrides,
  }
}

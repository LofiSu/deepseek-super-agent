import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { arbitrateSubscribers, bypassEligible } from '../src/core/intake.ts'
import type { AssessmentOutcome } from '../src/shared/ports.ts'
import { UserError } from '../src/shared/errors.ts'
import type { Decision, Disposition, Thread, Ticket, Trigger } from '../src/shared/types.ts'
import type { Runtime } from '../src/runtime.ts'
import { freshRuntime, shutdown } from './fixtures.ts'
import { ScriptedModel, silentModel } from './scripted-model.ts'

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

/** IM trigger with an explicit channel-address group; admission reads only that field. */
function groupTrigger(input: {
  id: string
  thread: string
  text: string
  group?: string
  actor?: string
}): Trigger {
  const base = imTrigger({
    id: input.id,
    thread: input.thread,
    text: input.text,
    actor: input.actor,
  })
  return {
    ...base,
    channel: {
      source: 'im',
      thread: input.thread,
      ...(input.group ? { address: { group: input.group } } : {}),
    },
  }
}

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

  it('bot/CI context reaches the existing Ticket and still becomes a new-work candidate', async () => {
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

    // A bot event is context for the live Ticket (it does not wake its Executor),
    // and it independently enters Eval as a new-work candidate.
    const disposition = runtime.store.getDoc<Disposition>('disposition', 'trg_ci')
    expect(disposition?.fanout).toEqual([])
    expect(disposition?.context).toEqual([original.id])
    expect(runtime.log.text()).not.toContain('bypass=subscription')
    const kept = runtime.store.getDoc<Ticket>('ticket', original.id)
    expect(kept?.inputs.some(input => input.triggerId === 'trg_ci' && input.kind === 'context')).toBe(true)
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

  it('refuses handback for a filtered trigger: no requeue and no ticket', async () => {
    runtime = freshRuntime({ admission: { groups: ['eng'] } })
    expect(runtime.ingest(groupTrigger({
      id: 'trg_admitted',
      thread: 'topic/bug-login',
      group: 'eng',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    const ticket = runtime.store.listDocs<Ticket>('ticket')[0]!
    const before = runtime.store.listDocs<Ticket>('ticket').length
    const subscriptions = runtime.store.getDoc<Thread>('thread', 'im:topic/bug-login')!.subscriptions

    expect(runtime.ingest(groupTrigger({
      id: 'trg_denied',
      thread: 'topic/bug-login',
      group: 'random',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('filtered')
    expect(runtime.store.getDoc<Disposition>('disposition', 'trg_denied')?.filtered)
      .toBe('fast:group-not-allowlisted')

    const engine = runtime.engine
    expect(() => engine.handback(ticket.id, 'trg_denied', 'probe')).toThrow(UserError)
    const thread = runtime.store.getDoc<Thread>('thread', 'im:topic/bug-login')!
    expect(thread.pending).not.toContain('trg_denied')
    expect(thread.subscriptions).toEqual(subscriptions)
    runtime.engine.evaluateDue()
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(before)
    await runtime.finish()
  })

  it('skips an already-queued filtered id in evaluateDue', async () => {
    runtime = freshRuntime({ admission: { groups: ['eng'] } })
    expect(runtime.ingest(groupTrigger({
      id: 'trg_denied',
      thread: 'topic/bug-login',
      group: 'random',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('filtered')

    // Simulate a stale pending entry left by an older process.
    const key = 'im:topic/bug-login'
    runtime.store.putDoc('thread', key, {
      key,
      ref: { source: 'im', id: 'topic/bug-login' },
      createdAt: '2026-10-31T00:00:00.000Z',
      subscriptions: [],
      correlated: [],
      pending: ['trg_denied'],
      meta: {},
    } satisfies Thread)

    expect(runtime.engine.evaluateDue()).toEqual([])
    expect(runtime.store.getDoc<Thread>('thread', key)?.pending).toEqual([])
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(0)
    expect(runtime.store.listDocs<Decision>('decision')).toHaveLength(0)
    expect(runtime.log.text()).toContain('Evals.skip-filtered')
    await runtime.finish()
  })

  it('still requeues and evaluates an admitted trigger through handback', async () => {
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

    expect(runtime.engine.handback(ticket.id, 'trg_login_2', 'not-our-bug')).toBe(true)
    const requeued = runtime.store.getDoc<Thread>('thread', 'im:topic/bug-login')!
    expect(requeued.pending).toContain('trg_login_2')
    expect(requeued.subscriptions).toEqual([])

    runtime.engine.evaluateDue()
    const tickets = runtime.store.listDocs<Ticket>('ticket')
    expect(tickets.length).toBeGreaterThan(1)
    expect(tickets.some(item => item.originTriggerId === 'trg_login_2')).toBe(true)
    await runtime.finish()
  })

  it('many-to-many: every live subscriber receives the same human follow-up', async () => {
    let clock = Date.parse('2026-10-31T00:00:00.000Z')
    // Fan-out is the subject here; the Worker turns are incidental. A live
    // model explores the checkout bug for minutes, so script them instead of
    // letting model latency decide whether this assertion fits a timeout.
    runtime = freshRuntime({ model: silentModel(), now: () => new Date(clock += 1000).toISOString() })
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
    const fanout = runtime.store.getDoc<Disposition>('disposition', 'trg_recent')?.fanout ?? []
    expect(fanout.sort()).toEqual([older!.id, newer!.id].sort())
    expect(runtime.log.text()).toContain(`bypass=subscription ticketId=${newer!.id}`)
    expect(runtime.log.text()).toContain(`bypass=subscription ticketId=${older!.id}`)
    expect(runtime.store.getDoc<Ticket>('ticket', older!.id)?.inputs.some(input => input.triggerId === 'trg_recent')).toBe(true)
    expect(runtime.store.getDoc<Ticket>('ticket', newer!.id)?.inputs.some(input => input.triggerId === 'trg_recent')).toBe(true)

    const ended = runtime.store.getDoc<Ticket>('ticket', newer!.id)!
    ended.ended = { at: '2026-10-31T00:00:09.000Z', outcome: 'ready', by: 'executor' }
    runtime.store.putDoc('ticket', ended.id, ended)
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

describe('filtered triggers cannot be resurrected', () => {
  const key = 'im:topic/bug-login'

  function seedFiltered(id = 'trg_denied'): void {
    expect(runtime!.ingest(groupTrigger({
      id,
      thread: 'topic/bug-login',
      group: 'random',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('filtered')
  }

  function seedDeferred(pending: string[]): void {
    runtime!.store.putDoc('thread', key, {
      key,
      ref: { source: 'im', id: 'topic/bug-login' },
      createdAt: '2026-10-31T00:00:00.000Z',
      subscriptions: [],
      correlated: [],
      pending,
      deferred: true,
      meta: {},
    } satisfies Thread)
  }

  function acceptOutcome(): AssessmentOutcome {
    return { kind: 'accept', reason: 'probe', title: 'Probe', scope: 'probe the report' }
  }

  function acceptModel(): ScriptedModel {
    return new ScriptedModel(() => ({
      text: JSON.stringify({
        kind: 'accept',
        reason: 'filtered regression',
        title: 'Fix login',
        scope: 'fix the login timeout',
      }),
    }))
  }

  it('clears a filtered-only deferred queue during Runtime.start assessment', async () => {
    runtime = freshRuntime({ model: silentModel(), admission: { groups: ['eng'] } })
    seedFiltered()
    seedDeferred(['trg_denied'])

    runtime.start()
    await runtime.assessmentsSettled()

    const thread = runtime.store.getDoc<Thread>('thread', key)!
    expect(thread.pending).toEqual([])
    expect(thread.deferred).toBe(false)
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(0)
    expect(runtime.store.listDocs<Decision>('decision')).toHaveLength(0)
    expect(runtime.log.text()).toContain('assess.skip-filtered')
    await runtime.finish()
  })

  it('treats an empty filtered reason as a denial for handback and eval', async () => {
    runtime = freshRuntime({ admission: { groups: ['eng'] } })
    seedFiltered()
    const disposition = runtime.store.getDoc<Disposition>('disposition', 'trg_denied')!
    disposition.filtered = ''
    runtime.store.putDoc('disposition', 'trg_denied', disposition)
    seedDeferred(['trg_denied'])

    const engine = runtime.engine
    expect(() => engine.handback('ticket_probe', 'trg_denied', 'probe')).toThrow(UserError)
    expect(engine.evaluateDue()).toEqual([])
    expect(runtime.store.getDoc<Thread>('thread', key)?.pending).toEqual([])
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(0)
    await runtime.finish()
  })

  it('commitAssessed refuses a filtered id and creates nothing', async () => {
    runtime = freshRuntime({ admission: { groups: ['eng'] } })
    seedFiltered()
    seedDeferred(['trg_denied'])

    expect(runtime.engine.commitAssessed(key, ['trg_denied'], acceptOutcome())).toBeUndefined()
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(0)
    expect(runtime.store.listDocs<Decision>('decision')).toHaveLength(0)
    // Refusal happens before any queue mutation.
    expect(runtime.store.getDoc<Thread>('thread', key)?.pending).toEqual(['trg_denied'])
    await runtime.finish()
  })

  it('decide refuses a filtered trigger and creates nothing', async () => {
    runtime = freshRuntime({ admission: { groups: ['eng'] } })
    seedFiltered()
    seedDeferred(['trg_denied'])

    const engine = runtime.engine
    expect(() => engine.decide('trg_denied', acceptOutcome())).toThrow(UserError)
    expect(() => engine.decide('trg_denied', acceptOutcome())).toThrow(/filtered.*re-admission/)
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(0)
    expect(runtime.store.listDocs<Decision>('decision')).toHaveLength(0)
    await runtime.finish()
  })

  it('keeps an admitted neighbor when assessment clears a filtered id', async () => {
    runtime = freshRuntime({ model: acceptModel(), admission: { groups: ['eng'] } })
    runtime.engine.receive(groupTrigger({
      id: 'trg_admitted',
      thread: 'topic/bug-login',
      group: 'eng',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    seedFiltered()
    seedDeferred(['trg_denied', 'trg_admitted'])

    runtime.start()
    await runtime.assessmentsSettled()

    const thread = runtime.store.getDoc<Thread>('thread', key)!
    expect(thread.pending).toEqual([])
    expect(thread.deferred).toBe(false)
    const tickets = runtime.store.listDocs<Ticket>('ticket')
    expect(tickets).toHaveLength(1)
    expect(tickets[0]!.originTriggerId).toBe('trg_admitted')
    expect(runtime.store.listDocs<Decision>('decision').some(decision =>
      decision.triggerIds.includes('trg_denied'))).toBe(false)
    await runtime.finish()
  })

  it('evaluateDue keeps an admitted neighbor and clears deferred on a mixed batch', async () => {
    runtime = freshRuntime({ admission: { groups: ['eng'] } })
    runtime.engine.receive(groupTrigger({
      id: 'trg_admitted',
      thread: 'topic/bug-login',
      group: 'eng',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    seedFiltered()
    seedDeferred(['trg_denied', 'trg_admitted'])

    const decisions = runtime.engine.evaluateDue()
    expect(decisions.map(decision => decision.kind)).toEqual(['accept'])
    expect(decisions[0]!.triggerIds).toEqual(['trg_admitted'])
    const thread = runtime.store.getDoc<Thread>('thread', key)!
    expect(thread.pending).toEqual([])
    expect(thread.deferred).toBe(false)
    const tickets = runtime.store.listDocs<Ticket>('ticket')
    expect(tickets).toHaveLength(1)
    expect(tickets[0]!.originTriggerId).toBe('trg_admitted')
    expect(runtime.log.text()).toContain('Evals.skip-filtered')
    expect(runtime.log.text()).not.toContain('Evals.batch size=2')
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

  it('reject-direct-chat', () => {
    const live = sampleTicket('ticket_chat', {
      channels: [{ source: 'imessage', thread: 'chat:any;-;+1', address: { handle: '+1' } }],
    })
    expect(bypassEligible(live, follow)).toBe(false)
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

  it('breaks a full tie by natural id order, not lexicographic order', () => {
    const nine = sampleTicket('ticket_9', { createdAt: '2026-10-31T00:00:00.000Z' })
    const ten = sampleTicket('ticket_10', { createdAt: '2026-10-31T00:00:00.000Z' })
    expect(arbitrateSubscribers([nine, ten])?.id).toBe('ticket_10')
    expect(arbitrateSubscribers([ten, nine])?.id).toBe('ticket_10')
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

import { describe, expect, it } from 'vitest'
import type { OutboundMessage, ReplyKind, ReplyStatus, Trigger } from '../shared/types.js'
import type { Outbox } from '../shared/ports.js'
import { openStore } from '../store/index.js'
import { Engine } from './engine.js'
import { AllowGate, MockAssessor, RecordingExecutor, ScriptedGate } from './mock.js'

class FakeOutbox implements Outbox {
  readonly sent: OutboundMessage[] = []

  send(message: OutboundMessage): void {
    if (this.sent.some(item => item.id === message.id)) return
    this.sent.push(message)
  }

  status(id: string): ReplyStatus | undefined {
    return this.sent.some(item => item.id === id) ? 'sent' : undefined
  }

  withdraw(): void {}
}

function trigger(id: string, text: string, extra?: Partial<Trigger>): Trigger {
  return {
    id,
    source: 'im',
    threads: [{ source: 'im', id: 'room-1' }],
    actor: { source: 'im', id: 'ada' },
    human: true,
    at: '2026-01-01T00:00:00.000Z',
    text,
    channel: { source: 'im', thread: 'room-1', address: { room: 'room-1' } },
    meta: {},
    ...extra,
  }
}

function setup(answer: ConstructorParameters<typeof MockAssessor>[0] = { kind: 'accept', title: 'Fix the build', scope: 'build' }) {
  const repos = openStore()
  const outbox = new FakeOutbox()
  const executor = new RecordingExecutor(repos)
  const assessor = new MockAssessor(answer)
  let now = '2026-01-01T00:00:00.000Z'
  let n = 0
  const engine = new Engine({
    repos,
    outbox,
    executor,
    assessor,
    gate: new AllowGate(),
    now: () => now,
    id: prefix => `${prefix}-${++n}`,
    evalTimeoutMs: 1000,
    policyVersion: 'p1',
    filter: item => item.meta.noise !== true,
  })
  return {
    repos,
    outbox,
    executor,
    assessor,
    engine,
    setNow(value: string) {
      now = value
    },
  }
}

describe('Engine.receive', () => {
  it('stores a trigger, drops duplicates, and filters noise', () => {
    const { engine, repos } = setup()
    expect(engine.receive(trigger('t1', 'please fix the build'))).toBe('stored')
    expect(engine.receive(trigger('t1', 'please fix the build'))).toBe('duplicate')
    expect(engine.receive(trigger('noise', 'hello', { meta: { noise: true } }))).toBe('filtered')
    expect(engine.receive(trigger('empty', 'x', { threads: [] }))).toBe('filtered')
    expect(repos.triggers.list().map(item => item.id)).toEqual(['t1'])
    expect(repos.threads.get('im:room-1')?.pending).toEqual(['t1'])
    expect(engine.events.some(event => event.type === 'trigger.received')).toBe(true)
  })

  it('batches queued triggers into one serial eval', () => {
    const { engine, assessor, repos } = setup({ kind: 'ignore', reason: 'not work' })
    engine.receive(trigger('t1', 'first'))
    engine.receive(trigger('t2', 'second', { at: '2026-01-01T00:00:01.000Z' }))
    engine.evaluateDue()
    expect(assessor.seen).toHaveLength(1)
    expect(assessor.seen[0]?.triggers.map(item => item.id)).toEqual(['t1', 't2'])
    expect(repos.decisions.byThread('im:room-1').map(item => item.kind)).toEqual(['ignore'])
    expect(repos.threads.get('im:room-1')?.evaluating).toBeUndefined()
    expect(repos.threads.get('im:room-1')?.pending).toEqual([])
  })
})

describe('evals', () => {
  it('keeps a second batch waiting while an eval is open', () => {
    const { engine, assessor, repos } = setup(() => undefined)
    engine.receive(trigger('t1', 'first'))
    engine.evaluateDue()
    engine.receive(trigger('t2', 'second', { at: '2026-01-01T00:00:01.000Z' }))
    engine.evaluateDue()
    const thread = repos.threads.get('im:room-1')
    expect(thread?.evaluating?.triggerIds).toEqual(['t1'])
    expect(thread?.pending).toEqual(['t2'])
    engine.decide(thread!.evaluating!.id, { kind: 'ignore' })
    engine.evaluateDue()
    expect(assessor.seen).toHaveLength(2)
    expect(assessor.seen[1]?.evaluation.triggerIds).toEqual(['t2'])
  })

  it('records ignore when the gate admits nobody', () => {
    const { engine, repos, assessor } = setup()
    const gateEngine = new Engine({
      repos,
      outbox: new FakeOutbox(),
      executor: new RecordingExecutor(repos),
      assessor,
      gate: new ScriptedGate(() => ({ admissible: false, reason: 'no' })),
      now: () => '2026-01-01T00:00:00.000Z',
      id: prefix => `${prefix}-gate`,
      filter: () => true,
    })
    gateEngine.receive(trigger('t1', 'hi'))
    gateEngine.evaluateDue()
    expect(assessor.seen).toHaveLength(0)
    expect(repos.decisions.byThread('im:room-1')[0]?.kind).toBe('ignore')
    expect(repos.tickets.list()).toEqual([])
  })

  it('records unavailable when the deadline passes', () => {
    const { engine, repos, setNow } = setup(() => undefined)
    engine.receive(trigger('t1', 'please fix the build'))
    engine.evaluateDue()
    expect(repos.threads.get('im:room-1')?.evaluating?.deadline).toBe('2026-01-01T00:00:01.000Z')
    setNow('2026-01-01T00:00:02.000Z')
    engine.evaluateDue()
    expect(repos.decisions.byThread('im:room-1')[0]).toMatchObject({ kind: 'unavailable', reason: 'deadline' })
    expect(repos.threads.get('im:room-1')?.evaluating).toBeUndefined()
  })

  it('rolls back the batch when assessment throws', () => {
    const { engine, repos, executor } = setup(() => {
      throw new Error('boom')
    })
    engine.receive(trigger('t1', 'please fix the build'))
    expect(() => engine.evaluateDue()).toThrow('boom')
    expect(repos.decisions.byThread('im:room-1')).toEqual([])
    expect(repos.threads.get('im:room-1')?.pending).toEqual(['t1'])
    expect(executor.started).toEqual([])
  })
})

describe('accept, fan-out, and replies', () => {
  it('creates a mandate, ticket, assignment, and subscription', () => {
    const { engine, repos, executor, outbox } = setup()
    engine.receive(trigger('t1', 'please fix the build'))
    engine.evaluateDue()
    const ticket = repos.tickets.open()[0]
    expect(ticket?.mandate).toMatchObject({ strength: 'explicit', policyVersion: 'p1', scope: 'build' })
    expect(repos.mandates.get(ticket!.id)).toEqual(ticket?.mandate)
    expect(ticket?.assignments.map(item => item.state)).toEqual(['pending'])
    expect(repos.subscriptions.byThread('im:room-1')).toEqual([{ threadKey: 'im:room-1', ticketId: ticket!.id }])
    expect(executor.started).toEqual([{ ticketId: ticket!.id, assignmentId: ticket!.assignments[0]!.id, stored: ticket!.id }])
    expect(outbox.sent.map(item => item.kind)).toEqual(['acknowledgement'])
    expect(repos.decisions.byThread('im:room-1')[0]?.kind).toBe('accept')
  })

  it('lets a person message that hits a ticket bypass eval', () => {
    const { engine, repos } = setup()
    engine.receive(trigger('t1', 'please fix the build'))
    engine.evaluateDue()
    const ticketId = repos.tickets.open()[0]!.id
    const follow = trigger('t2', 'same thread, more detail', { at: '2026-01-01T00:00:05.000Z' })
    expect(engine.receive(follow)).toBe('stored')
    expect(repos.threads.get('im:room-1')?.pending).toEqual([])
    expect(engine.fanouts).toContainEqual(expect.objectContaining({
      bypass: 'subscription',
      ticketId,
      triggerId: 't2',
    }))
    expect(JSON.stringify(engine.fanouts)).toContain('bypass":"subscription"')
    expect(JSON.stringify(engine.fanouts)).toContain(`"ticketId":"${ticketId}"`)
    expect(repos.tickets.get(ticketId)?.inputs?.some(input => input.triggerId === 't2')).toBe(true)
  })

  it('still evaluates a bot message and a context-only follow', () => {
    const { engine, repos, assessor } = setup()
    engine.receive(trigger('t1', 'please fix the build'))
    engine.evaluateDue()
    const ticketId = repos.tickets.open()[0]!.id
    engine.receive(trigger('bot', 'ci failed', {
      human: false,
      actor: { source: 'im', id: 'ci-bot' },
      at: '2026-01-01T00:00:06.000Z',
    }))
    expect(repos.threads.get('im:room-1')?.pending).toEqual(['bot'])
    expect(engine.fanouts.find(item => item.triggerId === 'bot')).toMatchObject({ bypass: 'subscription', ticketId })

    engine.receive(trigger('other', 'nearby', {
      threads: [{ source: 'im', id: 'room-2' }],
      channel: { source: 'im', thread: 'room-2', address: { room: 'room-2' } },
      at: '2026-01-01T00:00:07.000Z',
    }))
    engine.subscribe('im:room-2', ticketId, true)
    const seen = assessor.seen.length
    engine.receive(trigger('ctx', 'context only', {
      threads: [{ source: 'im', id: 'room-2' }],
      channel: { source: 'im', thread: 'room-2', address: { room: 'room-2' } },
      at: '2026-01-01T00:00:08.000Z',
    }))
    expect(repos.threads.get('im:room-2')?.pending).toEqual(['other', 'ctx'])
    assessor.answer = { kind: 'ignore' }
    engine.evaluateDue()
    expect(assessor.seen.length).toBe(seen + 2)
    expect(engine.fanouts.find(item => item.triggerId === 'ctx')?.ticketId).toBe(ticketId)
  })

  it('stops, refuses resume, and sends answer, result, and attention', () => {
    const { engine, repos, outbox } = setup()
    engine.receive(trigger('t1', 'please fix the build'))
    engine.evaluateDue()
    const ticket = repos.tickets.open()[0]!
    engine.reply(ticket.id, 'answer', 'on it')
    engine.reply(ticket.id, 'result', 'done')
    engine.reply(ticket.id, 'attention', 'which file?')
    expect(outbox.sent.map(item => item.kind)).toEqual(['acknowledgement', 'answer', 'result', 'attention'] satisfies ReplyKind[])
    engine.stopTicket(ticket.id, 'cancel')
    expect(repos.tickets.get(ticket.id)?.ended).toMatchObject({ by: 'human', outcome: 'stopped' })
    engine.receive(trigger('t2', 'please continue', { at: '2026-01-01T00:00:09.000Z' }))
    expect(engine.fanouts.find(item => item.triggerId === 't2')).toBeUndefined()
    expect(repos.threads.get('im:room-1')?.pending).toContain('t2')
    expect(repos.tickets.get(ticket.id)?.status).toBe('ended')
  })
})

describe('assignments', () => {
  it('starts, delivers inputs, reports, retries, and restarts after interrupt', () => {
    const { engine, repos, executor, outbox } = setup()
    engine.receive(trigger('t1', 'please fix the build'))
    engine.evaluateDue()
    const ticket = repos.tickets.open()[0]!
    const first = ticket.assignments[0]!
    engine.assignmentStarted(ticket.id, first.id)
    expect(executor.delivered[0]?.inputIds).toEqual(ticket.inputs?.map(input => input.id))
    engine.inputsDelivered(ticket.id, first.id, ticket.undelivered ?? [])
    expect(repos.tickets.get(ticket.id)?.undelivered).toEqual([])

    engine.report(ticket.id, first.id, { state: 'blocked', summary: 'need a log', at: '2026-01-01T00:00:03.000Z' })
    expect(outbox.sent.at(-1)?.kind).toBe('attention')
    engine.retryTicket(ticket.id)
    const retried = repos.tickets.get(ticket.id)!
    expect(retried.assignments).toHaveLength(2)
    expect(retried.assignments[1]?.state).toBe('pending')
    expect(executor.started).toHaveLength(2)

    const second = retried.assignments[1]!
    engine.assignmentStarted(ticket.id, second.id)
    engine.assignmentInterrupted(ticket.id, second.id)
    const after = repos.tickets.get(ticket.id)!
    expect(after.assignments.map(item => item.state)).toEqual(['ended', 'ended', 'pending'])
    expect(executor.stopped.map(item => item.reason)).toEqual(['interrupted'])
    expect(executor.started).toHaveLength(3)

    const third = after.assignments[2]!
    engine.assignmentStarted(ticket.id, third.id)
    engine.report(ticket.id, third.id, { state: 'ready', summary: 'fixed', at: '2026-01-01T00:00:04.000Z' })
    expect(repos.tickets.get(ticket.id)?.ended).toMatchObject({ by: 'executor', outcome: 'completed' })
    expect(outbox.sent.at(-1)).toMatchObject({ kind: 'result', text: 'fixed' })

    engine.receive(trigger('t2', 'one more thing', { at: '2026-01-01T00:00:10.000Z' }))
    expect(repos.tickets.get(ticket.id)?.status).toBe('open')
    expect(engine.fanouts.find(item => item.triggerId === 't2')).toMatchObject({ bypass: 'subscription', ticketId: ticket.id })
  })

  it('stops a ticket from an eval decision', () => {
    const { engine, repos, assessor } = setup()
    engine.receive(trigger('t1', 'please fix the build'))
    engine.evaluateDue()
    const ticketId = repos.tickets.open()[0]!.id
    engine.receive(trigger('t2', 'stop that', {
      threads: [{ source: 'im', id: 'room-9' }],
      channel: { source: 'im', thread: 'room-9', address: { room: 'room-9' } },
      at: '2026-01-01T00:00:11.000Z',
    }))
    assessor.answer = { kind: 'stop', ticketId, reason: 'cancel' }
    engine.evaluateDue()
    expect(repos.tickets.get(ticketId)?.ended?.outcome).toBe('stopped')
    expect(repos.decisions.byThread('im:room-9')[0]?.kind).toBe('stop')
  })
})

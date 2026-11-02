import { describe, expect, it } from 'vitest'
import { assessWithMainAgent } from '../src/core/assessment.ts'
import { Engine } from '../src/core/engine.ts'
import type { Host } from '../src/core/host.ts'
import { executionState } from '../src/core/stage.ts'
import { executionView } from '../src/core/panel.ts'
import { gateTriggers } from '../src/core/policy.ts'
import { Outbox } from '../src/channels/outbox-adapter.ts'
import { MockModel, type Completion, type CompletionRequest } from '../src/harness/model.ts'
import { Metrics } from '../src/metrics/metrics.ts'
import type { Disposition, Thread, Ticket, Trigger } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'
import { tempHome } from './fixtures.ts'

function fixture() {
  const home = tempHome()
  const store = new Store(home)
  const host: Host = {
    repo: store,
    now: () => new Date().toISOString(),
    metrics: new Metrics(home),
    log: () => undefined,
    scope: { admit: () => ({ listened: true, reason: 'test' }) },
  }
  return { home, store, host, engine: new Engine(host) }
}

function trigger(id: string, text: string, thread = 'topic/main', addressed = true): Trigger {
  return {
    id,
    source: 'im',
    threads: [{ source: 'im', id: thread }],
    actor: { source: 'im', id: 'alex' },
    human: true,
    addressed: addressed ? 'mention' : undefined,
    at: new Date().toISOString(),
    text,
    channel: { source: 'im', thread },
    meta: {},
  }
}

class AcceptAssessment extends MockModel {
  override async complete(request: CompletionRequest): Promise<Completion> {
    if (request.messages.some(message => String(message.content).includes('MAIN_ASSESSMENT'))) {
      return {
        text: JSON.stringify({
          kind: 'accept',
          reason: 'inferred request',
          title: 'Fix login',
          scope: 'fix the checkout login timeout',
          strength: 'inferred',
        }),
      }
    }
    return super.complete(request)
  }
}

describe('article domain alignment', () => {
  it('Gate defers inferred work and the Main Agent supplies title/scope for the Mandate', async () => {
    const { store, host } = fixture()
    const queued = trigger('trg_inferred', 'please fix the login timeout', 'topic/main', false)
    expect(gateTriggers([queued], undefined)).toMatchObject({ kind: 'defer' })

    const outcome = await assessWithMainAgent(new AcceptAssessment(), [queued], undefined)
    expect(outcome).toMatchObject({
      kind: 'accept',
      title: 'Fix login',
      scope: 'fix the checkout login timeout',
      strength: 'inferred',
    })

    const engine = new Engine(host)
    engine.receive(queued)
    const decision = engine.commitAssessed(
      'im:topic/main',
      (store.getDoc<Thread>('thread', 'im:topic/main')?.pending ?? []),
      outcome,
    )
    expect(decision?.kind).toBe('accept')
    const ticket = store.getDoc<Ticket>('ticket', decision!.ticketId!)!
    expect(ticket.title).toBe('Fix login')
    expect(ticket.mandate.scope).toBe('fix the checkout login timeout')
    expect(ticket.mandate.policyVersion).toBe('policy-v1')
    store.close()
  })

  it('a context-only Subscription reads context but neither wakes nor bypasses', () => {
    const { store, engine } = fixture()
    engine.receive(trigger('trg_a', '@ds-agent fix the login timeout'))
    engine.evaluateDue()
    const first = store.listDocs<Ticket>('ticket')[0]!
    store.putDoc('thread', 'im:topic/watch', {
      key: 'im:topic/watch',
      ref: { source: 'im', id: 'topic/watch' },
      createdAt: new Date().toISOString(),
      subscriptions: [],
      correlated: [],
      pending: [],
      meta: {},
    })
    engine.followForContext(first.id, 'im:topic/watch')

    engine.receive(trigger('trg_watch', '@ds-agent the payment service is also failing', 'topic/watch'))
    engine.evaluateDue()
    const disposition = store.getDoc<Disposition>('disposition', 'trg_watch')!
    expect(disposition.fanout).toEqual([])
    expect(disposition.context).toEqual([first.id])
    const ticket = store.getDoc<Ticket>('ticket', first.id)!
    expect(ticket.inputs.some(input => input.triggerId === 'trg_watch' && input.kind === 'context')).toBe(true)
    // The human message still becomes a new-work candidate.
    expect(store.listDocs<Ticket>('ticket').length).toBe(2)
    store.close()
  })

  it('failure ends the Assignment, and retry creates a new Assignment on the same Ticket', () => {
    const { store, engine } = fixture()
    engine.receive(trigger('trg_a', '@ds-agent fix the login timeout'))
    engine.evaluateDue()
    const ticket = store.listDocs<Ticket>('ticket')[0]!
    engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id, `worker_${ticket.id}`)
    engine.report(ticket.id, { kind: 'failed', text: 'tests could not run', deliver: false })

    const failed = store.getDoc<Ticket>('ticket', ticket.id)!
    expect(failed.ended).toBeUndefined()
    expect(failed.assignments).toHaveLength(1)
    expect(failed.assignments[0]?.state).toBe('ended')
    expect(executionState(failed)).toBe('blocked')

    engine.retryTicket(ticket.id, 'retry after failure')
    const retried = store.getDoc<Ticket>('ticket', ticket.id)!
    expect(retried.ended).toBeUndefined()
    expect(retried.assignments).toHaveLength(2)
    expect(retried.assignments[1]?.state).toBe('pending')
    expect(executionState(retried)).toBe('pending')
    store.close()
  })

  it('replies go to the Thread that produced the input, not the first Channel', () => {
    const { store, engine } = fixture()
    engine.receive(trigger('trg_a', '@ds-agent fix the login timeout', 'topic/a'))
    engine.evaluateDue()
    const ticket = store.listDocs<Ticket>('ticket')[0]!
    ticket.channels.push({ source: 'im', thread: 'topic/b' })
    ticket.threadKeys.push('im:topic/b')
    store.putDoc('ticket', ticket.id, ticket)

    engine.reply(ticket.id, 'the B thread answer', 'result', 'im:topic/b')
    const outbox = store.listOutbox()
    expect(outbox.at(-1)).toMatchObject({ thread: 'topic/b', ticketId: ticket.id })
    expect(outbox.at(-1)?.idempotencyKey).toBeTruthy()
    store.close()
  })

  it('Outbox retries a failed send instead of dropping it', async () => {
    const { store, engine } = fixture()
    engine.receive(trigger('trg_a', '@ds-agent fix the login timeout'))
    engine.evaluateDue()
    const ticket = store.listDocs<Ticket>('ticket')[0]!
    engine.reply(ticket.id, 'result body', 'result')

    let calls = 0
    const outbox = new Outbox(store, [{
      channel: 'im',
      async send() {
        calls += 1
        if (calls === 1) throw new Error('network down')
        return { externalId: 'msg_ok' }
      },
    }])

    const first = await outbox.flush()
    expect(first.failed).toBe(0)
    const retryRow = store.listOutbox('pending').at(-1)!
    expect(retryRow.attempts).toBe(1)
    expect(retryRow.status).toBe('pending')

    // Move the backoff into the past, then flush again.
    store.markOutboxRetry(retryRow.id, 'network down', '2000-01-01T00:00:00.000Z', 1)
    const second = await outbox.flush()
    expect(second.sent).toBe(1)
    expect(store.listOutbox('sent').some(row => row.externalId === 'msg_ok')).toBe(true)
    store.close()
  })

  it('Panel derives Execution state from facts and separates delivery from ticket end', () => {
    const { home, store, engine } = fixture()
    engine.receive(trigger('trg_a', '@ds-agent fix the login timeout'))
    engine.evaluateDue()
    const ticket = store.listDocs<Ticket>('ticket')[0]!
    const panel = executionView(store, home)
    expect(panel[0]).toMatchObject({
      ticketId: ticket.id,
      state: 'pending',
      outbox: { pending: 1, sent: 0, failed: 0 },
    })
    store.close()
  })
})

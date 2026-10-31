import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Assignment, Decision, Eval, Mandate, Source, Ticket, Trigger, Thread } from '../shared/types.js'
import { openStore } from './index.js'
import { toInline } from './spill.js'

const mandate: Mandate = {
  strength: 'explicit',
  policyVersion: 'p1',
  actor: { source: 'im', id: 'u1' },
  scope: 'fix the build',
}

const trigger: Trigger = {
  id: 't1',
  source: 'im',
  threads: [{ source: 'im', id: 'room-1' }],
  actor: { source: 'im', id: 'u1' },
  human: true,
  at: '2026-01-01T00:00:00.000Z',
  text: 'please fix the build',
  meta: { room: 'room-1' },
}

describe('sqlite store', () => {
  it('round-trips domain rows', () => {
    const store = openStore()
    const source: Source = { id: 'im-1', kind: 'im', enabled: true, cursor: '10' }
    const thread: Thread = {
      key: 'im:room-1',
      ref: { source: 'im', id: 'room-1' },
      createdAt: '2026-01-01T00:00:00.000Z',
      subscriptions: ['k1'],
      pending: ['t1'],
      meta: {},
    }
    const evaluation: Eval = {
      id: 'e1',
      threadKey: thread.key,
      triggerIds: ['t1'],
      strength: 'explicit',
      policyVersion: 'p1',
      startedAt: '2026-01-01T00:00:01.000Z',
    }
    const decision: Decision = {
      id: 'd1',
      evalId: 'e1',
      threadKey: thread.key,
      triggerIds: ['t1'],
      policyVersion: 'p1',
      at: '2026-01-01T00:00:02.000Z',
      kind: 'accept',
      strength: 'explicit',
      ticketId: 'k1',
      mandate,
    }
    const assignment: Assignment = {
      id: 'a1',
      ticketId: 'k1',
      state: 'pending',
      createdAt: '2026-01-01T00:00:02.000Z',
    }
    const ticket: Ticket = {
      id: 'k1',
      title: 'fix the build',
      decisionId: 'd1',
      mandate,
      channels: [{ source: 'im', thread: 'room-1', address: { room: 'room-1' } }],
      status: 'open',
      assignments: [assignment],
      createdAt: '2026-01-01T00:00:02.000Z',
      updatedAt: '2026-01-01T00:00:02.000Z',
    }

    store.sources.save(source)
    store.triggers.save(trigger)
    store.threads.save(thread)
    store.evals.save(evaluation)
    store.mandates.save(ticket.id, mandate)
    store.tickets.save(ticket)
    store.assignments.save(assignment)
    store.subscriptions.save({ threadKey: thread.key, ticketId: ticket.id })
    store.channels.save({ ref: ticket.channels[0]!, ticketId: ticket.id })
    store.decisions.save(decision)
    const job = store.start('session-1')

    expect(store.sources.get('im-1')).toEqual(source)
    expect(store.triggers.list()).toEqual([trigger])
    expect(store.threads.get(thread.key)).toEqual(thread)
    expect(store.evals.byThread(thread.key)).toEqual([evaluation])
    expect(store.mandates.get(ticket.id)).toEqual(mandate)
    expect(store.tickets.open()).toEqual([ticket])
    expect(store.assignments.byTicket(ticket.id)).toEqual([assignment])
    expect(store.subscriptions.byThread(thread.key)).toEqual([{ threadKey: thread.key, ticketId: ticket.id }])
    expect(store.channels.byTicket(ticket.id)).toEqual([{ ref: ticket.channels[0], ticketId: ticket.id }])
    expect(store.decisions.byThread(thread.key)).toEqual([decision])
    expect(store.jobs.bySession('session-1')).toEqual([job])
    expect(job.status).toBe('started')

    store.subscriptions.remove(thread.key, ticket.id)
    expect(store.subscriptions.byTicket(ticket.id)).toEqual([])
    store.close()
  })

  it('rolls back an atomic unit of work', () => {
    const store = openStore()
    expect(() => store.atomic(() => {
      store.triggers.save(trigger)
      throw new Error('nope')
    })).toThrow('nope')
    expect(store.triggers.get('t1')).toBeUndefined()
    store.close()
  })

  it('reopens a temp database', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ds-agent-'))
    const file = path.join(dir, 'agent.sqlite')
    const first = openStore(file)
    first.triggers.save(trigger)
    first.close()
    const second = openStore(file)
    expect(second.triggers.get('t1')).toEqual(trigger)
    second.close()
  })
})

describe('spill', () => {
  it('stores large bodies and keeps inline to summary plus ids', () => {
    const store = openStore(':memory:', () => '2026-01-01T00:00:00.000Z')
    const body = 'x'.repeat(50_000)
    const textId = store.spill.put(body)
    const jsonId = store.spill.put({ log: 'full' }, 'short')
    const bytesId = store.spill.put(Uint8Array.from([1, 2, 3]))
    const inline = toInline('build log', [textId, jsonId])

    expect(inline).toEqual({ summary: 'build log', spillIds: [textId, jsonId] })
    expect(store.spill.get(textId)?.summary).toBe('x'.repeat(160))
    expect(store.spill.readObject(textId)).toBe(body)
    expect(store.spill.readObject(jsonId)).toEqual({ log: 'full' })
    expect(store.spill.get(jsonId)?.summary).toBe('short')
    expect(Buffer.from(store.spill.readObject(bytesId) as Uint8Array)).toEqual(Buffer.from([1, 2, 3]))
    expect(store.spill.readObject('missing')).toBeUndefined()
    store.close()
  })
})

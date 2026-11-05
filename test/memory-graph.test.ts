import { describe, expect, it } from 'vitest'
import { readObjectFor, readSpillFor } from '../src/memory/acl.ts'
import { refsForDecision, refsForTicket, refsForTrigger, threadRef, triggerRef } from '../src/memory/graph.ts'
import { SpillBackedLongTermMemory } from '../src/memory/long-term.ts'
import type { Decision, Thread, Ticket, Trigger } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'
import { tempHome } from './fixtures.ts'

function thread(key: string): Thread {
  const [source, ...rest] = key.split(':')
  return {
    key,
    ref: { source: source!, id: rest.join(':') },
    createdAt: '2026-01-01T00:00:00.000Z',
    subscriptions: [],
    correlated: [],
    pending: [],
    meta: {},
  }
}

function ticket(id: string, threadKeys: string[], title = 'auth failure'): Ticket {
  const t: Ticket = {
    id,
    title,
    brief: 'authentication failed after token rotation',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-v1',
      scope: title,
      actor: { source: 'github', id: 'lofisu' },
      basis: 'addressed',
    },
    threadKeys,
    channels: [{ source: 'github', thread: threadKeys[0]!.split(':').slice(1).join(':') }],
    inputs: [],
    assignments: [],
    speculative: false,
    originTriggerId: `trg_${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  t.refs = refsForTicket(t)
  return t
}

describe('Chain of Recall object graph', () => {
  it('persists next-hop refs with a spill and returns them on a granted read', () => {
    const store = new Store(tempHome())
    const refs = [threadRef('github:42')]
    const spillId = store.putSpill('full body', refs)
    expect(store.getSpillRefs(spillId)).toEqual(refs)

    store.grantSpill(spillId, 'ticket:ticket_a')
    expect(readSpillFor(store, spillId, { ticketId: 'ticket_a' }).refs).toEqual(refs)
    expect(() => readSpillFor(store, spillId, { ticketId: 'ticket_b' })).toThrow(/not visible/)
    store.close()
  })

  it('follows trigger -> thread -> ticket and refuses an unrelated ticket', () => {
    const store = new Store(tempHome())
    const a = ticket('ticket_a', ['github:42'])
    const b = ticket('ticket_b', ['github:99'])
    store.putDoc('ticket', a.id, a)
    store.putDoc('ticket', b.id, b)
    store.putDoc('thread', 'github:42', thread('github:42'))
    const trigger: Trigger = {
      id: 'trg_1',
      source: 'github',
      threads: [{ source: 'github', id: '42' }],
      actor: { source: 'github', id: 'lofisu' },
      human: true,
      at: '2026-01-01T00:00:00.000Z',
      text: 'CI failed on auth test',
      channel: { source: 'github', thread: '42' },
      meta: {},
    }
    trigger.refs = refsForTrigger(trigger, undefined, [triggerRef('trg_0')])
    store.putDoc('trigger', trigger.id, trigger)

    const triggerPage = readObjectFor(store, 'trigger:trg_1', { ticketId: 'ticket_a' })
    expect(triggerPage.refs.map(ref => ref.id)).toContain('thread:github:42')
    expect(triggerPage.refs.map(ref => ref.id)).toContain('trigger:trg_0')
    expect(readObjectFor(store, 'thread:github:42', { ticketId: 'ticket_a' }).text)
      .toContain('thread=github:42')
    expect(readObjectFor(store, 'ticket:ticket_a', { ticketId: 'ticket_a' }).text)
      .toContain('ticket=ticket_a')

    expect(() => readObjectFor(store, 'ticket:ticket_a', { ticketId: 'ticket_b' }))
      .toThrow(/not visible/)
    expect(() => readObjectFor(store, 'trigger:trg_1', { ticketId: 'ticket_b' }))
      .toThrow(/not visible/)
    store.close()
  })

  it('stores Router decisions as global memory with thread refs', () => {
    const store = new Store(tempHome())
    const memory = new SpillBackedLongTermMemory(store)
    const decision: Decision = {
      id: 'dec_1',
      evalId: 'eval_1',
      threadKey: 'github:42',
      triggerIds: ['trg_1'],
      kind: 'accept',
      ticketId: 'ticket_a',
      at: '2026-01-01T00:00:00.000Z',
      reason: 'chosen plan A in the IM thread',
      strength: 'explicit',
    }
    decision.refs = refsForDecision(decision)
    const entry = memory.rememberDecision(decision)

    expect(entry.kind).toBe('decision')
    expect(entry.refs?.map(ref => ref.id)).toContain('thread:github:42')
    const threaded = memory.forThreads(['github:42'], 5, 'ticket_reader')
    expect(threaded.map(item => item.id)).toContain(entry.id)
    expect(readSpillFor(store, entry.spillId, { ticketId: 'ticket_reader' }).text)
      .toContain('chosen plan A')
    expect(memory.query({ ticketId: 'ticket_reader', text: 'plan A' }).map(item => item.id))
      .toContain(entry.id)
    store.close()
  })

  it('archives pruned ticket memories into a cold thread digest', () => {
    const store = new Store(tempHome())
    let tick = 0
    const memory = new SpillBackedLongTermMemory(store, {
      maxEntries: 2,
      maxAgeDays: 0,
      coldMaxEntries: 10,
      coldMaxAgeDays: 3650,
      now: () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1_000),
    })
    for (const id of ['a', 'b', 'c']) {
      const t = ticket(`ticket_${id}`, ['github:42'], `gateway 401 incident ${id}`)
      t.refs = refsForTicket(t)
      memory.remember(t)
    }

    const hot = store.listDocs<{ tier?: string }>('ltm').filter(entry => (entry.tier ?? 'hot') === 'hot')
    const cold = store.listDocs<{ tier?: string; kind?: string }>('ltm')
      .filter(entry => entry.tier === 'cold' && entry.kind === 'digest')
    expect(hot).toHaveLength(2)
    expect(cold).toHaveLength(1)
    expect(memory.query({ ticketId: 'ticket_reader', text: 'gateway 401', tier: 'cold' }))
      .toHaveLength(1)
    store.close()
  })

  it('keeps thread digests separate when keys differ only in escaped characters', () => {
    const store = new Store(tempHome())
    let tick = 0
    const memory = new SpillBackedLongTermMemory(store, {
      maxEntries: 1,
      maxAgeDays: 0,
      coldMaxEntries: 10,
      coldMaxAgeDays: 3650,
      now: () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1_000),
    })
    memory.remember(ticket('ticket_slash', ['github:pr/7'], 'slash route incident'))
    memory.remember(ticket('ticket_under', ['github:pr_7'], 'underscore route incident'))
    memory.remember(ticket('ticket_third', ['github:pr/8'], 'other route incident'))

    const digests = store.listDocs<{ tier?: string; kind?: string }>('ltm')
      .filter(entry => entry.tier === 'cold' && entry.kind === 'digest')
    expect(digests).toHaveLength(2)
    const slash = memory.forThreads(['github:pr/7'], 5, 'ticket_reader')
    const under = memory.forThreads(['github:pr_7'], 5, 'ticket_reader')
    expect(slash.map(entry => entry.spillId)).not.toEqual(under.map(entry => entry.spillId))
    expect(slash.every(entry => store.getSpill(entry.spillId)?.includes('slash route incident'))).toBe(true)
    expect(under.every(entry => store.getSpill(entry.spillId)?.includes('underscore route incident'))).toBe(true)
    store.close()
  })
})

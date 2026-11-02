import { describe, expect, it } from 'vitest'
import { readSpillFor } from '../src/memory/acl.ts'
import { SpillBackedLongTermMemory } from '../src/memory/long-term.ts'
import { memoryRetentionFromEnv } from '../src/runtime.ts'
import type { Ticket } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'
import { tempHome } from './fixtures.ts'

describe('Long-term memory', () => {
  it('persists memories and recalls them across ticket ids', () => {
    const home = tempHome()
    const store = new Store(home)
    const memory = new SpillBackedLongTermMemory(store)
    const saved = memory.put('ticket_a', 'Authentication failed because the token expired.')
    expect(store.getDoc('ltm', saved.id)).toEqual(saved)
    expect(store.getSpill(saved.spillId)).toBe('Authentication failed because the token expired.')
    expect(() => readSpillFor(store, saved.spillId, { ticketId: 'ticket_b' })).toThrow()
    store.close()

    const reopened = new Store(home)
    const results = new SpillBackedLongTermMemory(reopened)
      .query({ ticketId: 'ticket_b', text: 'token expired' })
    expect(results).toEqual([saved])
    expect(readSpillFor(reopened, saved.spillId, { ticketId: 'ticket_b' }).text)
      .toBe('Authentication failed because the token expired.')
    reopened.close()
  })

  it('filters by body, limits results, and requires a reader ticket', () => {
    const store = new Store(tempHome())
    const memory = new SpillBackedLongTermMemory(store)
    memory.put('ticket_a', 'A unique stack trace for auth middleware')
    memory.put('ticket_c', 'Another auth middleware incident')
    expect(memory.query({ ticketId: 'ticket_b', text: 'auth middleware', limit: 1 })).toHaveLength(1)
    expect(memory.query({ ticketId: 'ticket_b', text: 'unique stack' })).toHaveLength(1)
    expect(memory.query({ ticketId: 'ticket_b', text: 'missing' })).toEqual([])
    expect(() => memory.query({ text: 'auth' })).toThrow(/ticketId/)
    store.close()
  })

  it('redacts caller-supplied text before writing the spill and summary', () => {
    const store = new Store(tempHome())
    const memory = new SpillBackedLongTermMemory(store, text => text.replace('s3cret', '[redacted]'))
    const saved = memory.put('ticket_a', 'token=s3cret')
    expect(store.getSpill(saved.spillId)).toBe('token=[redacted]')
    expect(saved.text).toBe('token=[redacted]')
    store.close()
  })

  it('prunes the oldest entries and their spills by count', () => {
    const store = new Store(tempHome())
    let tick = 0
    const memory = new SpillBackedLongTermMemory(store, {
      maxEntries: 2,
      now: () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1_000),
    })
    const first = memory.put('ticket_a', 'oldest body')
    const second = memory.put('ticket_a', 'middle body')
    const third = memory.put('ticket_a', 'newest body')

    expect(store.getDoc('ltm', first.id)).toBeUndefined()
    expect(store.getSpill(first.spillId)).toBeUndefined()
    expect(store.spillGrants(first.spillId)).toEqual([])
    expect(() => readSpillFor(store, first.spillId, { ticketId: 'ticket_a' })).toThrow()
    expect(memory.recent().map(entry => entry.id)).toEqual([third.id, second.id])
    store.close()
  })

  it('prunes entries older than the age limit and keeps recent ones', () => {
    const store = new Store(tempHome())
    let clock = new Date('2026-01-01T00:00:00.000Z')
    const memory = new SpillBackedLongTermMemory(store, text => text, {
      maxAgeDays: 30,
      now: () => clock,
    })
    const stale = memory.put('ticket_a', 'stale body')
    clock = new Date('2026-02-15T00:00:00.000Z')
    const fresh = memory.put('ticket_a', 'fresh body')

    expect(store.getDoc('ltm', stale.id)).toBeUndefined()
    expect(store.getSpill(stale.spillId)).toBeUndefined()
    expect(store.getDoc('ltm', fresh.id)).toEqual(fresh)
    expect(memory.recent().map(entry => entry.id)).toEqual([fresh.id])
    store.close()
  })

  it('never prunes the entry just upserted by remember', () => {
    const store = new Store(tempHome())
    let clock = new Date('2026-01-01T00:00:00.000Z')
    const memory = new SpillBackedLongTermMemory(store, text => text, {
      maxEntries: 1,
      maxAgeDays: 30,
      now: () => clock,
    })
    const ticket = ticketFixture('ticket_old')
    const first = memory.remember(ticket)
    clock = new Date('2026-03-20T00:00:00.000Z')
    const second = memory.remember({ ...ticket, title: 'updated issue' })

    expect(second.id).toBe(first.id)
    expect(second.createdAt).toBe(first.createdAt)
    expect(store.getDoc('ltm', first.id)).toEqual(second)
    expect(store.getSpill(first.spillId)).toContain('updated issue')
    expect(memory.recent()).toHaveLength(1)
    store.close()
  })

  it('forget removes the document, its spill, and every grant', () => {
    const store = new Store(tempHome())
    const memory = new SpillBackedLongTermMemory(store)
    const saved = memory.put('ticket_a', 'forget me')
    expect(store.spillGrants(saved.spillId).length).toBeGreaterThan(0)

    expect(memory.forget(saved.id)).toBe(true)
    expect(store.getDoc('ltm', saved.id)).toBeUndefined()
    expect(store.getSpill(saved.spillId)).toBeUndefined()
    expect(store.spillGrants(saved.spillId)).toEqual([])
    expect(() => readSpillFor(store, saved.spillId, { ticketId: 'ticket_a' })).toThrow()
    expect(memory.forget(saved.id)).toBe(false)
    store.close()
  })

  it('parses retention env with conservative defaults and 0 as disabled', () => {
    expect(memoryRetentionFromEnv({})).toEqual({ maxEntries: 1000, maxAgeDays: 90 })
    expect(memoryRetentionFromEnv({
      DS_AGENT_MEMORY_MAX_ENTRIES: '',
      DS_AGENT_MEMORY_MAX_AGE_DAYS: '  ',
    })).toEqual({ maxEntries: 1000, maxAgeDays: 90 })
    expect(memoryRetentionFromEnv({
      DS_AGENT_MEMORY_MAX_ENTRIES: 'not-a-number',
      DS_AGENT_MEMORY_MAX_AGE_DAYS: '-3',
    })).toEqual({ maxEntries: 1000, maxAgeDays: 90 })
    expect(memoryRetentionFromEnv({ DS_AGENT_MEMORY_MAX_ENTRIES: '1.5' }))
      .toEqual({ maxEntries: 1000, maxAgeDays: 90 })
    expect(memoryRetentionFromEnv({
      DS_AGENT_MEMORY_MAX_ENTRIES: '0',
      DS_AGENT_MEMORY_MAX_AGE_DAYS: '0',
    })).toEqual({ maxEntries: 0, maxAgeDays: 0 })
    expect(memoryRetentionFromEnv({}, { maxEntries: 7 }))
      .toEqual({ maxEntries: 7, maxAgeDays: 90 })
  })
})

function ticketFixture(id: string): Ticket {
  return {
    id,
    title: 'older issue',
    brief: 'durable memory ticket',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-v1',
      scope: 'durable memory ticket',
      actor: { source: 'github', id: 'LofiSu' },
      basis: 'addressed',
    },
    threadKeys: ['github:issue:7'],
    channels: [{ source: 'github', thread: 'issue:7', address: { provider: 'github', repo: 'LofiSu/x', issue: '7' } }],
    inputs: [],
    assignments: [{
      id: 'asg_1',
      state: 'ended',
      speculative: false,
      report: { kind: 'report', text: 'finished the work' },
    }],
    speculative: false,
    originTriggerId: 'gh_issue_7_body',
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

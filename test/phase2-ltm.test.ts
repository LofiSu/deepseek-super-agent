import { describe, expect, it } from 'vitest'
import { readSpillFor } from '../src/memory/acl.ts'
import { phase2, SpillBackedLongTermMemory } from '../src/phase2/index.ts'
import { Store } from '../src/store/sqlite.ts'
import { tempHome } from './fixtures.ts'

describe('Phase-2 long-term memory', () => {
  it('persists memories and recalls them across ticket ids', () => {
    const home = tempHome()
    const store = new Store(home)
    const memory = phase2.longTermMemory(store)
    expect(memory).toBeInstanceOf(SpillBackedLongTermMemory)
    const saved = memory.put('ticket_a', 'Authentication failed because the token expired.')
    expect(store.getDoc('ltm', saved.id)).toEqual(saved)
    expect(store.getSpill(saved.spillId)).toBe('Authentication failed because the token expired.')
    expect(() => readSpillFor(store, saved.spillId, { ticketId: 'ticket_b' })).toThrow()
    store.close()

    const reopened = new Store(home)
    const results = phase2.longTermMemory(reopened).query({ ticketId: 'ticket_b', text: 'token expired' })
    expect(results).toEqual([saved])
    expect(readSpillFor(reopened, saved.spillId, { ticketId: 'ticket_b' }).text)
      .toBe('Authentication failed because the token expired.')
    reopened.close()
  })

  it('filters by body, limits results, and requires a reader ticket', () => {
    const store = new Store(tempHome())
    const memory = phase2.longTermMemory(store)
    memory.put('ticket_a', 'A unique stack trace for auth middleware')
    memory.put('ticket_c', 'Another auth middleware incident')
    expect(memory.query({ ticketId: 'ticket_b', text: 'auth middleware', limit: 1 })).toHaveLength(1)
    expect(memory.query({ ticketId: 'ticket_b', text: 'unique stack' })).toHaveLength(1)
    expect(memory.query({ ticketId: 'ticket_b', text: 'missing' })).toEqual([])
    expect(() => memory.query({ text: 'auth' })).toThrow(/ticketId/)
    store.close()
  })
})

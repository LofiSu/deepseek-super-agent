import { describe, expect, it } from 'vitest'
import { readSpillFor } from '../src/memory/acl.ts'
import { SpillBackedLongTermMemory } from '../src/memory/long-term.ts'
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
})

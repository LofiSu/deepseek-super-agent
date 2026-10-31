import { grantTicketSpill } from '../memory/acl.ts'
import type { Store } from '../store/sqlite.ts'
import type { LongTermMemoryEntry, LongTermMemoryQuery } from './types.ts'

/** Explicitly constructed, persistent cross-ticket memory index. */
export class SpillBackedLongTermMemory {
  constructor(private readonly store: Store) {}

  put(ticketId: string, text: string): LongTermMemoryEntry {
    if (!ticketId.trim() || !text.trim()) throw new Error('ticketId and text are required')
    return this.store.atomic(() => {
      const spillId = this.store.putSpill(text)
      const entry: LongTermMemoryEntry = {
        id: this.store.nextId('ltm'), ticketId, spillId,
        text: text.replace(/\s+/g, ' ').trim().slice(0, 160),
        createdAt: new Date().toISOString(),
      }
      this.store.putDoc('ltm', entry.id, entry)
      grantTicketSpill(this.store, spillId, ticketId)
      return entry
    })
  }

  query(query: LongTermMemoryQuery): LongTermMemoryEntry[] {
    if (!query.ticketId?.trim()) throw new Error('ticketId is required to query memory')
    const words = query.text.toLowerCase().trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) return []
    const limit = Math.max(0, Math.floor(query.limit ?? 10))
    return this.store.atomic(() => {
      const matches = this.store.listDocs<LongTermMemoryEntry>('ltm')
        .filter(entry => {
          const body = this.store.getSpill(entry.spillId)?.toLowerCase() ?? ''
          return words.every(word => body.includes(word))
        })
        .slice(0, limit)
      for (const entry of matches) grantTicketSpill(this.store, entry.spillId, query.ticketId!)
      return matches
    })
  }
}

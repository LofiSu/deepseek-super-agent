import { grantTicketSpill } from './acl.ts'
import type { Ticket } from '../shared/types.ts'
import type { Store } from '../store/sqlite.ts'

export interface LongTermMemoryQuery {
  /** Reader ticket. Required: a memory id alone is not a capability. */
  ticketId?: string
  text: string
  limit?: number
  tags?: string[]
}

export type LongTermMemoryKind = 'note' | 'ticket'

export interface LongTermMemoryEntry {
  id: string
  ticketId: string
  spillId: string
  /** Redacted summary. The full body is in the spill. */
  text: string
  createdAt: string
  kind?: LongTermMemoryKind
  tags?: string[]
}

const SUMMARY_CHARS = 160

/**
 * Persistent cross-ticket memory index (T48). A body is stored as a spill;
 * recall grants the reader ticket access for that spill only, so a memory id
 * alone is never a capability.
 */
export class SpillBackedLongTermMemory {
  constructor(
    private readonly store: Store,
    /** Applied before anything is written, including caller-supplied `put` text. */
    private readonly redact: (text: string) => string = text => text,
  ) {}

  put(ticketId: string, text: string, opts: { tags?: string[] } = {}): LongTermMemoryEntry {
    if (!ticketId.trim() || !text.trim()) throw new Error('ticketId and text are required')
    const safe = this.redact(text)
    return this.store.atomic(() => {
      const spillId = this.store.putSpill(safe)
      const entry: LongTermMemoryEntry = {
        id: this.store.nextId('ltm'),
        ticketId,
        spillId,
        text: summarize(safe),
        createdAt: new Date().toISOString(),
        kind: 'note',
        tags: normalizeTags(opts.tags),
      }
      this.store.putDoc('ltm', entry.id, entry)
      grantTicketSpill(this.store, spillId, ticketId)
      return entry
    })
  }

  /**
   * One durable entry per finished ticket, upserted by ticket id. The next
   * ticket on the same theme can recall it through `query`.
   */
  remember(ticket: Ticket): LongTermMemoryEntry {
    const report = ticket.assignments.at(-1)?.report?.text
    const text = this.redact([...new Set([ticket.title, ticket.brief, report]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0))]
      .join('\n'))
    const id = `ltm_${ticket.id}`
    return this.store.atomic(() => {
      const existing = this.store.getDoc<LongTermMemoryEntry>('ltm', id)
      const spillId = existing?.spillId ?? `ltm_spill_${ticket.id}`
      this.store.replaceSpill(spillId, text)
      const entry: LongTermMemoryEntry = {
        id,
        ticketId: ticket.id,
        spillId,
        text: summarize(text),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        kind: 'ticket',
        tags: normalizeTags([...ticket.threadKeys, ...ticket.channels.map(channel => channel.source)]),
      }
      this.store.putDoc('ltm', id, entry)
      grantTicketSpill(this.store, spillId, ticket.id)
      return entry
    })
  }

  query(query: LongTermMemoryQuery): LongTermMemoryEntry[] {
    if (!query.ticketId?.trim()) throw new Error('ticketId is required to query memory')
    const words = query.text.toLowerCase().trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) return []
    const wanted = normalizeTags(query.tags)
    const limit = Math.max(0, Math.floor(query.limit ?? 10))
    return this.store.atomic(() => {
      const matches = this.store.listDocs<LongTermMemoryEntry>('ltm')
        .filter(entry => {
          if (wanted.length && !wanted.every(tag => entry.tags?.includes(tag))) return false
          const body = this.store.getSpill(entry.spillId)?.toLowerCase() ?? ''
          return words.every(word => body.includes(word))
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
      for (const entry of matches) grantTicketSpill(this.store, entry.spillId, query.ticketId!)
      return matches
    })
  }

  recent(limit = 10): LongTermMemoryEntry[] {
    return this.store.listDocs<LongTermMemoryEntry>('ltm')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(0, Math.floor(limit)))
  }

  forget(id: string): boolean {
    const entry = this.store.getDoc<LongTermMemoryEntry>('ltm', id)
    if (!entry) return false
    this.store.deleteDoc?.('ltm', id)
    return true
  }
}

function summarize(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= SUMMARY_CHARS ? clean : `${clean.slice(0, SUMMARY_CHARS - 1)}…`
}

function normalizeTags(tags: readonly string[] | undefined): string[] {
  return [...new Set((tags ?? []).map(tag => tag.trim()).filter(Boolean))]
}

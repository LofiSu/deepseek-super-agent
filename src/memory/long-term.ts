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

/**
 * Retention for the durable index. Either dimension is disabled by 0 or by
 * omitting it; `undefined` is not "keep everything by accident" for callers
 * such as the Runtime, which supplies conservative defaults.
 */
export interface LongTermMemoryRetention {
  /** Keep at most this many entries (oldest pruned first). 0 disables. */
  maxEntries?: number
  /** Delete entries older than this many days. 0 disables. */
  maxAgeDays?: number
}

export interface LongTermMemoryOptions extends LongTermMemoryRetention {
  /** Injectable clock for deterministic age/count pruning tests. */
  now?: () => Date
}


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
  /** Effective limits (0 means that dimension is disabled). */
  readonly retention: Readonly<{ maxEntries: number; maxAgeDays: number }>
  private readonly redact: (text: string) => string
  private readonly clock: () => Date

  constructor(store: Store, options?: LongTermMemoryOptions)
  constructor(store: Store, redact?: (text: string) => string, options?: LongTermMemoryOptions)
  constructor(
    private readonly store: Store,
    /** Applied before anything is written, including caller-supplied `put` text. */
    redactOrOptions: ((text: string) => string) | LongTermMemoryOptions = text => text,
    options: LongTermMemoryOptions = {},
  ) {
    const retention = typeof redactOrOptions === 'function' ? options : redactOrOptions
    this.redact = typeof redactOrOptions === 'function' ? redactOrOptions : text => text
    this.retention = Object.freeze({
      maxEntries: normalizeLimit(retention.maxEntries),
      maxAgeDays: normalizeLimit(retention.maxAgeDays),
    })
    this.clock = retention.now ?? (() => new Date())
  }

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
        createdAt: this.clock().toISOString(),
        kind: 'note',
        tags: normalizeTags(opts.tags),
      }
      this.store.putDoc('ltm', entry.id, entry)
      grantTicketSpill(this.store, spillId, ticketId)
      this.prune(entry.id)
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
        createdAt: existing?.createdAt ?? this.clock().toISOString(),
        kind: 'ticket',
        tags: normalizeTags([...ticket.threadKeys, ...ticket.channels.map(channel => channel.source)]),
      }
      this.store.putDoc('ltm', id, entry)
      grantTicketSpill(this.store, spillId, ticket.id)
      this.prune(entry.id)
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

  /** Drop the index entry and its body (spill + grants) in one transaction. */
  forget(id: string): boolean {
    const entry = this.store.getDoc<LongTermMemoryEntry>('ltm', id)
    if (!entry) return false
    this.store.atomic(() => {
      this.store.deleteDoc('ltm', id)
      this.store.deleteSpill(entry.spillId)
    })
    return true
  }

  /**
   * Runs inside the caller's `store.atomic()` transaction. The entry that was
   * just written/upserted is never removed by its own retention pass, even
   * when its preserved `createdAt` would otherwise age it out.
   */
  private prune(protectedId: string): void {
    const { maxEntries, maxAgeDays } = this.retention
    if (maxEntries <= 0 && maxAgeDays <= 0) return
    const entries = this.store.listDocs<LongTermMemoryEntry>('ltm')
    if (entries.length <= 1) return
    const indexById = new Map(entries.map((entry, index) => [entry.id, index]))
    const doomed = new Set<string>()
    if (maxAgeDays > 0) {
      const cutoff = this.clock().getTime() - maxAgeDays * 86_400_000
      for (const entry of entries) {
        if (entry.id === protectedId) continue
        const createdAt = Date.parse(entry.createdAt)
        if (Number.isFinite(createdAt) && createdAt < cutoff) doomed.add(entry.id)
      }
    }
    if (maxEntries > 0) {
      const survivors = entries.filter(entry => !doomed.has(entry.id))
      const hasProtected = survivors.some(entry => entry.id === protectedId)
      // Newest first; equal timestamps fall back to insertion order (rowid).
      const ranked = survivors
        .filter(entry => entry.id !== protectedId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)
          || (indexById.get(b.id) ?? 0) - (indexById.get(a.id) ?? 0))
      const quota = Math.max(0, maxEntries - (hasProtected ? 1 : 0))
      for (const entry of ranked.slice(quota)) doomed.add(entry.id)
    }
    const oldestFirst = [...doomed].sort((a, b) => {
      const byTime = (entries[indexById.get(a)!]?.createdAt ?? '').localeCompare(
        entries[indexById.get(b)!]?.createdAt ?? '',
      )
      return byTime || (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0)
    })
    for (const id of oldestFirst) {
      this.store.deleteDoc('ltm', id)
      const spillId = entries[indexById.get(id)!]?.spillId
      if (spillId) this.store.deleteSpill(spillId)
    }
  }
}

function normalizeLimit(value: number | undefined): number {
  const limit = Math.floor(value ?? 0)
  return Number.isFinite(limit) && limit > 0 ? limit : 0
}

function summarize(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= SUMMARY_CHARS ? clean : `${clean.slice(0, SUMMARY_CHARS - 1)}…`
}

function normalizeTags(tags: readonly string[] | undefined): string[] {
  return [...new Set((tags ?? []).map(tag => tag.trim()).filter(Boolean))]
}

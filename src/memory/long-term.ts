import type { Store } from '../store/sqlite.ts'

/** One spilled body indexed for later lookup. This is a substring index, not a vector store. */
export interface MemoryRecord {
  spillId: string
  ticketId?: string
  summary: string
  preview: string
  at: string
}

export interface LongTermMemoryPort {
  remember(input: {
    spillId: string
    summary: string
    preview: string
    ticketId?: string
    at?: string
  }): void
  search(query: string, limit?: number): MemoryRecord[]
  attach(spillId: string, ticketId: string): void
}

export class MemoryApi implements LongTermMemoryPort {
  constructor(private readonly store: Store) {}

  remember(input: {
    spillId: string
    summary: string
    preview: string
    ticketId?: string
    at?: string
  }): void {
    const spillId = input.spillId.trim()
    if (!spillId) throw new Error('remember needs a spill id')
    this.store.indexSpill({
      spillId,
      ticketId: input.ticketId,
      summary: squash(input.summary, 160),
      preview: squash(input.preview, 240),
      at: input.at ?? new Date().toISOString(),
    })
  }

  search(query: string, limit = 8): MemoryRecord[] {
    const cap = Math.min(50, Math.max(1, Math.floor(limit)))
    return this.store.searchSpills(query, cap)
  }

  attach(spillId: string, ticketId: string): void {
    this.store.attachSpill(spillId, ticketId)
  }
}

function squash(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

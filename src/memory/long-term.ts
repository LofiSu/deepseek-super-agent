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

interface QueryCandidate {
  entry: LongTermMemoryEntry
  tags: ReadonlySet<string>
  tagHits: number
  textHits: number
  hopScore: number
  direct: boolean
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

  /**
   * Store a note. Dedupe policy: for the same ticket, text that is identical
   * after redaction + normalization (whitespace collapsed, trimmed,
   * case-insensitive) reuses the existing entry, unions its tags, and creates
   * no second document or spill. Only entries with a readable spill body can
   * match; a zombie entry (missing spill) is never matched against its
   * truncated summary, so the write creates a fresh, recallable entry instead.
   * Different text (or the same text for another ticket) is stored as before.
   */
  put(ticketId: string, text: string, opts: { tags?: string[] } = {}): LongTermMemoryEntry {
    if (!ticketId.trim() || !text.trim()) throw new Error('ticketId and text are required')
    const safe = this.redact(text)
    const wanted = normalizeTags(opts.tags)
    const dedupeKey = normalizeForDedupe(safe)
    return this.store.atomic(() => {
      const existing = this.store.listDocs<LongTermMemoryEntry>('ltm')
        .find(entry => entry.ticketId === ticketId && dedupeKeyOf(this.store, entry) === dedupeKey)
      if (existing) {
        const entry: LongTermMemoryEntry = {
          ...existing,
          tags: normalizeTags([...(existing.tags ?? []), ...wanted]),
        }
        this.store.putDoc('ltm', entry.id, entry)
        this.prune(entry.id)
        return entry
      }
      const spillId = this.store.putSpill(safe)
      const entry: LongTermMemoryEntry = {
        id: this.store.nextId('ltm'),
        ticketId,
        spillId,
        text: summarize(safe),
        createdAt: this.clock().toISOString(),
        kind: 'note',
        tags: wanted,
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

  /**
   * Lexical recall (ADR-010; also documented in docs/MODULES.md M6).
   *
   * Query and body tokens are NFKC-normalized, lower-cased, split on
   * punctuation/whitespace, and mapped to canonical synonyms/morphology.
   * Query stop words are removed. Unlike the pre-ADR behavior, candidates are
   * partial-overlap matches: any query token in the tagged body or in the
   * entry's tags makes an entry a direct candidate. Requested `tags` remain an
   * exact AND filter and are not relaxed.
   *
   * Scoring (deterministic, no model/provider):
   *
   *   tagHits  = number of canonical tag tokens that match a distinct query
   *              token or a requested tag
   *   textHits = sum over each distinct query token of its occurrences in the
   *              canonical body tokens, with each token capped at 5
   *   hopScore = one-hop contribution from direct candidates that share a tag
   *
   *   order    = tagHits desc, textHits desc, hopScore desc, createdAt desc,
   *              id desc
   *
   * One hop only: seeds are the direct candidates. The tag index is built from
   * the same retention-bounded entry set, so the walk is bounded and there is
   * no unbounded graph traversal. Only entries with a readable spill body are
   * eligible; every returned hit still grants the reader ticket access to that
   * exact spill, so a memory id alone remains a reference, not a capability.
   */
  query(query: LongTermMemoryQuery): LongTermMemoryEntry[] {
    if (!query.ticketId?.trim()) throw new Error('ticketId is required to query memory')
    const words = queryTokens(query.text)
    if (words.length === 0) return []
    const wanted = normalizeTags(query.tags)
    const needles = new Set([...words, ...wanted.flatMap(tag => canonicalTokens(tag))])
    const limit = Math.max(0, Math.floor(query.limit ?? 10))
    return this.store.atomic(() => {
      const candidates: QueryCandidate[] = []
      const tagIndex = new Map<string, number[]>()
      for (const entry of this.store.listDocs<LongTermMemoryEntry>('ltm')) {
        if (wanted.length && !wanted.every(tag => entry.tags?.includes(tag))) continue
        const body = this.store.getSpill(entry.spillId)
        if (body == null) continue
        const counts = canonicalTokenCounts(body)
        const tags = new Set(canonicalTokens((entry.tags ?? []).join(' ')))
        const tagHits = [...tags].filter(tag => needles.has(tag)).length
        const wordTagHits = words.filter(word => tags.has(word)).length
        let textHits = 0
        for (const word of words) textHits += Math.min(5, counts.get(word) ?? 0)
        const index = candidates.length
        candidates.push({
          entry,
          tags,
          tagHits,
          textHits,
          hopScore: 0,
          direct: textHits > 0 || wordTagHits > 0,
        })
        for (const tag of tags) {
          const bucket = tagIndex.get(tag)
          if (bucket) bucket.push(index)
          else tagIndex.set(tag, [index])
        }
      }
      // One hop, seeded only by direct candidates. The per-query tag index maps
      // each canonical tag to its retention-bounded bucket. Sum seed weight per
      // tag once, then read it back once per bucket entry; this stays linear in
      // the number of entry/tag pairs instead of walking a seed/neighbor
      // cross-product. Newly reached entries never seed another hop.
      for (const bucket of tagIndex.values()) {
        let seedWeight = 0
        for (const index of bucket) {
          const candidate = candidates[index]
          if (candidate?.direct) seedWeight += 1 + candidate.tagHits + candidate.textHits
        }
        if (seedWeight === 0) continue
        for (const index of bucket) {
          const candidate = candidates[index]
          if (candidate) candidate.hopScore += seedWeight
        }
      }
      for (const candidate of candidates) {
        if (!candidate.direct) continue
        // A direct candidate is not its own neighbor.
        const weight = 1 + candidate.tagHits + candidate.textHits
        candidate.hopScore -= weight * candidate.tags.size
      }
      const matches = candidates
        .filter(candidate => candidate.direct || candidate.hopScore > 0)
        .sort((a, b) => b.tagHits - a.tagHits
          || b.textHits - a.textHits
          || b.hopScore - a.hopScore
          || b.entry.createdAt.localeCompare(a.entry.createdAt)
          || b.entry.id.localeCompare(a.entry.id))
        .slice(0, limit)
        .map(candidate => candidate.entry)
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

/** Dedupe key: collapse whitespace, trim, and compare case-insensitively. */
function normalizeForDedupe(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Compare against the full body only. A missing spill yields `undefined`, so a
 * zombie entry can never match via its truncated summary.
 */
function dedupeKeyOf(store: Store, entry: LongTermMemoryEntry): string | undefined {
  const body = store.getSpill(entry.spillId)
  return body == null ? undefined : normalizeForDedupe(body)
}

/**
 * Small, explicit, in-repo synonym/morphology map. The first word in each
 * group is canonical. It is deliberately tiny and deterministic: no learned
 * vocabulary, no model, no external dependency.
 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['token', 'tokens', 'credential', 'credentials'],
  ['rotate', 'rotated', 'rotates', 'rotating', 'rotation', 'rotations'],
  ['prune', 'prunes', 'pruned', 'pruning', 'remove', 'removes', 'removed', 'removal'],
  ['old', 'older', 'oldest'],
  ['entry', 'entries'],
  ['fail', 'failed', 'failing', 'failure', 'failures'],
  ['expand', 'expanded', 'expands', 'expansion'],
  ['synonym', 'synonyms'],
  ['paraphrase', 'paraphrases'],
  ['own', 'owns', 'owned', 'owner', 'ownership'],
  ['restore', 'restored', 'restores', 'restoring'],
  ['deploy', 'deploys', 'deployed', 'deployment', 'deployments'],
  ['release', 'releases', 'released'],
  ['incident', 'incidents'],
  ['auth', 'authentication', 'authenticate', 'authenticated'],
  ['memory', 'memories'],
  ['retention', 'retain', 'retains', 'retained'],
  ['measure', 'measures', 'measured', 'measuring'],
  ['evaluate', 'evaluation', 'evaluates', 'evaluated'],
  ['embed', 'embedding', 'embeddings'],
  ['expire', 'expired', 'expires', 'expiration', 'expiring'],
  ['retry', 'retries', 'retried', 'retrying'],
  ['reject', 'rejects', 'rejected', 'rejection', 'invalid'],
  ['queue', 'queued', 'queues'],
  ['delay', 'delays', 'delayed', 'latency', 'latencies'],
  ['missing', 'absent'],
  ['reply', 'replies', 'replied', 'replying'],
  ['deliver', 'delivers', 'delivered', 'delivery'],
  ['configure', 'configures', 'configured', 'configuration'],
  ['allow', 'allows', 'allowed', 'allowlist'],
  ['deny', 'denies', 'denied'],
  ['install', 'installs', 'installed', 'installation'],
  ['origin', 'originating', 'originates', 'original'],
  ['approve', 'approves', 'approved', 'approval', 'approvals'],
  ['permanent', 'permanently'],
  ['transient', 'transiently'],
  ['performance', 'perf'],
  ['group', 'groups'],
  ['error', 'errors'],
  ['message', 'messages'],
  ['command', 'commands'],
  ['row', 'rows'],
]

const CANONICAL = new Map<string, string>()
for (const group of SYNONYM_GROUPS) {
  const canonical = group[0]!
  for (const word of group) CANONICAL.set(word, canonical)
}

/** Query-only stop words. Body tokens are kept so phrase statistics stay intact. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'before', 'but', 'by',
  'did', 'do', 'does', 'for', 'from', 'how', 'if', 'in', 'into', 'is', 'it',
  'its', 'no', 'nor', 'not', 'of', 'on', 'or', 'over', 'so', 'such', 'than',
  'that', 'the', 'their', 'then', 'there', 'these', 'this', 'to', 'was',
  'were', 'what', 'when', 'where', 'which', 'who', 'whose', 'why', 'will',
  'with', 'without',
])

/** NFKC, lower-case, and collapse punctuation/whitespace into single spaces. */
function tokenize(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function canonicalTokens(text: string): string[] {
  return tokenize(text).map(token => CANONICAL.get(token) ?? token)
}

function queryTokens(text: string): string[] {
  return [...new Set(canonicalTokens(text).filter(token => !STOPWORDS.has(token)))]
}

function canonicalTokenCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of canonicalTokens(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return counts
}

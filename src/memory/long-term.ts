import { grantTicketSpill } from './acl.ts'
import { mergeRefs, refsForDecision, refsForTicket, threadRef } from './graph.ts'
import type { Decision, ObjectRef, Ticket } from '../shared/types.ts'
import type { Store } from '../store/sqlite.ts'

export interface LongTermMemoryQuery {
  /** Reader ticket. Required: a memory id alone is not a capability. */
  ticketId?: string
  text: string
  limit?: number
  tags?: string[]
  /** Optional tier filter. Absent means hot and cold entries are both eligible. */
  tier?: LongTermMemoryTier
}

export type LongTermMemoryKind = 'note' | 'ticket' | 'decision' | 'digest'

/** Hot entries are ticket/decision memories; cold entries are archived thread digests. */
export type LongTermMemoryTier = 'hot' | 'cold'

/**
 * Retention for the durable index. Either dimension is disabled by 0 or by
 * omitting it; `undefined` is not "keep everything by accident" for callers
 * such as the Runtime, which supplies conservative defaults.
 */
export interface LongTermMemoryRetention {
  /** Keep at most this many hot entries (oldest pruned first). 0 disables. */
  maxEntries?: number
  /** Delete hot entries older than this many days. 0 disables. */
  maxAgeDays?: number
  /** Keep at most this many cold digests. 0 disables. */
  coldMaxEntries?: number
  /** Delete cold digests older than this many days. 0 disables. */
  coldMaxAgeDays?: number
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
  tier?: LongTermMemoryTier
  /** Next-hop refs inlined for Chain of Recall. */
  refs?: ObjectRef[]
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
  readonly retention: Readonly<{
    maxEntries: number
    maxAgeDays: number
    coldMaxEntries: number
    coldMaxAgeDays: number
  }>
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
      coldMaxEntries: normalizeLimit(retention.coldMaxEntries ?? 200),
      coldMaxAgeDays: normalizeLimit(retention.coldMaxAgeDays ?? 3650),
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
  put(
    ticketId: string,
    text: string,
    opts: {
      tags?: string[]
      refs?: readonly ObjectRef[]
      kind?: LongTermMemoryKind
      tier?: LongTermMemoryTier
    } = {},
  ): LongTermMemoryEntry {
    if (!ticketId.trim() || !text.trim()) throw new Error('ticketId and text are required')
    const safe = this.redact(text)
    const wanted = normalizeTags(opts.tags)
    const refs = mergeRefs(opts.refs ?? [])
    const dedupeKey = normalizeForDedupe(safe)
    return this.store.atomic(() => {
      const existing = this.store.listDocs<LongTermMemoryEntry>('ltm')
        .find(entry => entry.ticketId === ticketId && dedupeKeyOf(this.store, entry) === dedupeKey)
      if (existing) {
        const mergedRefs = mergeRefs(existing.refs ?? [], refs)
        const entry: LongTermMemoryEntry = {
          ...existing,
          tags: normalizeTags([...(existing.tags ?? []), ...wanted]),
          refs: mergedRefs,
        }
        // Dedupe never rewrites the body; only the ref graph may grow.
        const body = this.store.getSpill(existing.spillId)
        if (body != null) this.store.replaceSpill(existing.spillId, body, mergedRefs)
        this.store.putDoc('ltm', entry.id, entry)
        this.prune(entry.id)
        return entry
      }
      const spillId = this.store.putSpill(safe, refs)
      const entry: LongTermMemoryEntry = {
        id: this.store.nextId('ltm'),
        ticketId,
        spillId,
        text: summarize(safe),
        createdAt: this.clock().toISOString(),
        kind: opts.kind ?? 'note',
        tier: opts.tier ?? 'hot',
        tags: wanted,
        refs,
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
    const refs = mergeRefs(ticket.refs ?? refsForTicket(ticket))
    return this.store.atomic(() => {
      const existing = this.store.getDoc<LongTermMemoryEntry>('ltm', id)
      const spillId = existing?.spillId ?? `ltm_spill_${ticket.id}`
      this.store.replaceSpill(spillId, text, refs)
      const entry: LongTermMemoryEntry = {
        id,
        ticketId: ticket.id,
        spillId,
        text: summarize(text),
        createdAt: existing?.createdAt ?? this.clock().toISOString(),
        kind: 'ticket',
        tier: 'hot',
        tags: normalizeTags([...ticket.threadKeys, ...ticket.channels.map(channel => channel.source)]),
        refs,
      }
      this.store.putDoc('ltm', id, entry)
      grantTicketSpill(this.store, spillId, ticket.id)
      this.prune(entry.id)
      return entry
    })
  }

  /**
   * Router global memory (§2.1): one durable entry per terminal Decision, so
   * "we chose A here, then switched to B there" survives across Tickets and
   * channels. Idempotent by decision id.
   */
  rememberDecision(decision: Decision): LongTermMemoryEntry {
    const text = this.redact([
      `decision ${decision.kind} on ${decision.threadKey}`,
      decision.reason,
      `triggers ${decision.triggerIds.join(' ')}`,
      ...(decision.ticketId ? [`ticket ${decision.ticketId}`] : []),
    ].join('\n'))
    const id = `ltm_decision_${decision.id}`
    const refs = mergeRefs(decision.refs ?? refsForDecision(decision))
    return this.store.atomic(() => {
      const existing = this.store.getDoc<LongTermMemoryEntry>('ltm', id)
      const spillId = existing?.spillId ?? `ltm_decision_spill_${decision.id}`
      this.store.replaceSpill(spillId, text, refs)
      const entry: LongTermMemoryEntry = {
        id,
        ticketId: decision.ticketId ?? `decision:${decision.id}`,
        spillId,
        text: summarize(text),
        createdAt: existing?.createdAt ?? this.clock().toISOString(),
        kind: 'decision',
        tier: 'hot',
        tags: normalizeTags(['decision', decision.kind, decision.threadKey]),
        refs,
      }
      this.store.putDoc('ltm', id, entry)
      if (decision.ticketId) grantTicketSpill(this.store, spillId, decision.ticketId)
      this.prune(entry.id)
      return entry
    })
  }

  /**
   * Decisions, ticket memories, and archived digests for these Threads.
   * This is how the Router sees cross-task context even when the next title
   * does not lexically match the earlier one.
   */
  forThreads(threadKeys: readonly string[], limit = 5, readerTicketId?: string): LongTermMemoryEntry[] {
    const wanted = new Set(threadKeys)
    if (wanted.size === 0) return []
    const entries = this.store.listDocs<LongTermMemoryEntry>('ltm')
      .filter(entry => (entry.tags ?? []).some(tag => wanted.has(tag))
        || (entry.refs ?? []).some(ref => ref.kind === 'thread' && wanted.has(ref.id.replace(/^thread:/, ''))))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, Math.max(0, Math.floor(limit)))
    // Same rule as query(): the reader gets the exact spill of every hit.
    if (readerTicketId) {
      for (const entry of entries) grantTicketSpill(this.store, entry.spillId, readerTicketId)
    }
    return entries
  }

  /**
   * Router global memory (§2.1): the newest Decisions across every Thread.
   * The Router is the global sequence point, so a decision made in one channel
   * can steer a Ticket opened in another. Worker injection stays Thread-local.
   */
  recentDecisions(limit = 5, readerTicketId?: string): LongTermMemoryEntry[] {
    const entries = this.store.listDocs<LongTermMemoryEntry>('ltm')
      .filter(entry => entry.kind === 'decision')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, Math.max(0, Math.floor(limit)))
    if (readerTicketId) {
      for (const entry of entries) grantTicketSpill(this.store, entry.spillId, readerTicketId)
    }
    return entries
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
        if (query.tier && (entry.tier ?? 'hot') !== query.tier) continue
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
          || tierRank(a) - tierRank(b)
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
   * Runs inside the caller's `store.atomic()` transaction. Hot ticket/decision
   * entries follow `maxEntries`/`maxAgeDays`; cold thread digests follow their
   * own limits. Before a hot entry is deleted, its summary is folded into the
   * Thread digest so month-scale recall survives ticket pruning (§8.1).
   */
  private prune(protectedId: string): void {
    const entries = this.store.listDocs<LongTermMemoryEntry>('ltm')
    if (entries.length <= 1) return
    const indexById = new Map(entries.map((entry, index) => [entry.id, index]))
    const hot = entries.filter(entry => (entry.tier ?? 'hot') === 'hot')
    const cold = entries.filter(entry => entry.tier === 'cold')
    const doomed = new Set<string>([
      ...selectDoomed(hot, this.retention.maxEntries, this.retention.maxAgeDays, protectedId, this.clock),
      ...selectDoomed(cold, this.retention.coldMaxEntries, this.retention.coldMaxAgeDays, protectedId, this.clock),
    ])
    const archived = hot.filter(entry => doomed.has(entry.id) && entry.id !== protectedId && entry.kind !== 'digest')
    if (archived.length) this.archive(archived)
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

  /**
   * Fold pruned ticket/decision summaries into one bounded cold digest per
   * Thread. The digest keeps handles, not grants: `query()` still grants the
   * reader ticket on every hit.
   */
  private archive(entries: readonly LongTermMemoryEntry[]): void {
    const byThread = new Map<string, LongTermMemoryEntry[]>()
    for (const entry of entries) {
      const threads = (entry.refs ?? [])
        .filter(ref => ref.kind === 'thread')
        .map(ref => ref.id.replace(/^thread:/, ''))
      for (const key of threads) {
        const bucket = byThread.get(key)
        if (bucket) bucket.push(entry)
        else byThread.set(key, [entry])
      }
    }
    for (const [key, bucket] of byThread) {
      const id = `ltm_digest_${encodeId(key)}`
      const spillId = `ltm_digest_spill_${encodeId(key)}`
      const existing = this.store.getDoc<LongTermMemoryEntry>('ltm', id)
      const ordered = [...bucket].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      const block = [
        `archived ${ordered.length} entries for ${key}`,
        ...ordered.map(entry => `${entry.createdAt} ${entry.text}`),
      ].join('\n')
      const text = capDigest(existing ? `${block}\n${this.store.getSpill(existing.spillId) ?? existing.text}` : block)
      const refs = mergeRefs(existing?.refs ?? [], [threadRef(key)])
      this.store.replaceSpill(spillId, text, refs)
      const digest: LongTermMemoryEntry = {
        id,
        ticketId: `thread:${key}`,
        spillId,
        text: summarize(text),
        createdAt: existing?.createdAt ?? this.clock().toISOString(),
        kind: 'digest',
        tier: 'cold',
        tags: normalizeTags([key, 'digest']),
        refs,
      }
      this.store.putDoc('ltm', id, digest)
    }
  }
}

function normalizeLimit(value: number | undefined): number {
  const limit = Math.floor(value ?? 0)
  return Number.isFinite(limit) && limit > 0 ? limit : 0
}

function selectDoomed(
  entries: readonly LongTermMemoryEntry[],
  maxEntries: number,
  maxAgeDays: number,
  protectedId: string,
  clock: () => Date,
): Set<string> {
  const doomed = new Set<string>()
  if (maxEntries <= 0 && maxAgeDays <= 0) return doomed
  const indexById = new Map(entries.map((entry, index) => [entry.id, index]))
  if (maxAgeDays > 0) {
    const cutoff = clock().getTime() - maxAgeDays * 86_400_000
    for (const entry of entries) {
      if (entry.id === protectedId) continue
      const createdAt = Date.parse(entry.createdAt)
      if (Number.isFinite(createdAt) && createdAt < cutoff) doomed.add(entry.id)
    }
  }
  if (maxEntries > 0) {
    const survivors = entries.filter(entry => !doomed.has(entry.id))
    const hasProtected = survivors.some(entry => entry.id === protectedId)
    const ranked = survivors
      .filter(entry => entry.id !== protectedId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)
        || (indexById.get(b.id) ?? 0) - (indexById.get(a.id) ?? 0))
    const quota = Math.max(0, maxEntries - (hasProtected ? 1 : 0))
    for (const entry of ranked.slice(quota)) doomed.add(entry.id)
  }
  return doomed
}

function tierRank(candidate: QueryCandidate): number {
  return candidate.entry.tier === 'cold' ? 1 : 0
}

/**
 * Injective, filesystem-safe encoding for a Thread key. Two distinct keys must
 * never share one digest: base64url is one-to-one, while character
 * substitution would merge e.g. `github:pr/7` and `github:pr_7`.
 */
function encodeId(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url')
}

/** Cold digests stay bounded even after many pruning passes. */
function capDigest(text: string): string {
  const CLEAN = text.replace(/\r\n?/g, '\n')
  return CLEAN.length <= 4000 ? CLEAN : `${CLEAN.slice(0, 3999)}…`
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

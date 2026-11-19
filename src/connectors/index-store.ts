import { canonicalTokens, queryTokens } from '../memory/text.ts'
import { UserError } from '../shared/errors.ts'
import type { Store } from '../store/sqlite.ts'
import {
  CONNECTOR_KINDS,
  connectorRecordId,
  isGoogleService,
  type ConnectorDraft,
  type ConnectorQuery,
  type ConnectorRecord,
} from './types.ts'

/**
 * The connector data index.
 *
 * This is deliberately not long-term memory. It lives under its own document
 * kind, has its own query interface, and does not require a reader ticket or
 * create a spill. Indexing a Gmail message or a calendar event never writes an
 * `ltm` row. Long-term memory remains the cross-ticket recall store owned by
 * M6; this class is the owner-facing source index owned by the connector
 * capability.
 *
 * Records are redacted before storage. Query results are read-only.
 */

export const CONNECTOR_DOC_KIND = 'connector'

export interface ConnectorIndexOptions {
  redact?: (text: string) => string
  now?: () => Date
}

export interface ConnectorUpsert {
  inserted: number
  updated: number
  unchanged: number
  skipped: number
  /** Every valid record, including unchanged ones, for wake evaluation. */
  records: ConnectorRecord[]
}

export interface ConnectorIndexStats {
  count: number
  services: Partial<Record<string, number>>
  oldest?: string
  newest?: string
}

interface Scored {
  record: ConnectorRecord
  score: number
}

export class ConnectorIndex {
  private readonly redact: (text: string) => string
  private readonly writesEnabled: boolean
  private readonly now: () => Date

  constructor(
    private readonly store: Store,
    options: ConnectorIndexOptions = {},
  ) {
    this.writesEnabled = typeof options.redact === 'function'
    this.redact = options.redact ?? (text => text)
    this.now = options.now ?? (() => new Date())
  }

  upsert(drafts: readonly ConnectorDraft[]): ConnectorUpsert {
    if (!this.writesEnabled) {
      throw new UserError('connector index writes require an explicit redaction function')
    }
    let inserted = 0
    let updated = 0
    let unchanged = 0
    let skipped = 0
    const records: ConnectorRecord[] = []
    const indexedAt = this.now().toISOString()
    for (const draft of drafts) {
      const record = this.normalize(draft, indexedAt)
      if (!record) {
        skipped += 1
        continue
      }
      const existing = this.store.getDoc<ConnectorRecord>(CONNECTOR_DOC_KIND, record.id)
      if (!existing) {
        this.store.putDoc(CONNECTOR_DOC_KIND, record.id, record)
        inserted += 1
      } else if (sameRecord(existing, record)) {
        unchanged += 1
      } else {
        this.store.putDoc(CONNECTOR_DOC_KIND, record.id, record)
        updated += 1
      }
      // Return the current normalized shape even when unchanged, so the wake
      // policy can evaluate a repeated calendar occurrence without a write.
      records.push(record)
    }
    return { inserted, updated, unchanged, skipped, records }
  }

  query(query: ConnectorQuery = {}): ConnectorRecord[] {
    const since = parseBound(query.since, 'since')
    const until = parseBound(query.until, 'until')
    if (query.service !== undefined && !isGoogleService(query.service)) {
      throw new UserError(`unknown connector service ${String(query.service)}`)
    }
    if (query.kind !== undefined && !CONNECTOR_KINDS.includes(query.kind)) {
      throw new UserError(`unknown connector kind ${String(query.kind)}`)
    }
    const tokens = [...new Set(queryTokens(query.text ?? ''))]
    const scored: Scored[] = []
    for (const record of this.store.listDocs<ConnectorRecord>(CONNECTOR_DOC_KIND)) {
      if (query.service !== undefined && record.service !== query.service) continue
      if (query.kind !== undefined && record.kind !== query.kind) continue
      if (query.wakeOnly === true && record.wake !== true) continue
      const at = Date.parse(record.occurredAt)
      if (since !== undefined && (!Number.isFinite(at) || at < since)) continue
      if (until !== undefined && (!Number.isFinite(at) || at >= until)) continue
      if (tokens.length > 0) {
        const score = scoreRecord(record, tokens)
        if (score === 0) continue
        scored.push({ record, score })
      } else {
        scored.push({ record, score: 0 })
      }
    }
    scored.sort(compareScored)
    const limit = normalizeLimit(query.limit)
    return scored.slice(0, limit).map(item => item.record)
  }

  get(id: string): ConnectorRecord | undefined {
    return this.store.getDoc<ConnectorRecord>(CONNECTOR_DOC_KIND, id)
  }

  stats(): ConnectorIndexStats {
    const records = this.store.listDocs<ConnectorRecord>(CONNECTOR_DOC_KIND)
    const services: Partial<Record<string, number>> = {}
    let oldest: number | undefined
    let newest: number | undefined
    for (const record of records) {
      services[record.service] = (services[record.service] ?? 0) + 1
      const at = Date.parse(record.occurredAt)
      if (!Number.isFinite(at)) continue
      if (oldest === undefined || at < oldest) oldest = at
      if (newest === undefined || at > newest) newest = at
    }
    return {
      count: records.length,
      services,
      ...(oldest === undefined ? {} : { oldest: new Date(oldest).toISOString() }),
      ...(newest === undefined ? {} : { newest: new Date(newest).toISOString() }),
    }
  }

  /**
   * Bound the index. `maxRecords=0` and `maxAgeDays=0` each disable one
   * dimension, matching the memory retention convention. Returns the number of
   * rows removed.
   */
  prune(options: { maxRecords?: number; maxAgeDays?: number } = {}): number {
    const maxRecords = options.maxRecords ?? 0
    const maxAgeDays = options.maxAgeDays ?? 0
    const records = this.store.listDocs<ConnectorRecord>(CONNECTOR_DOC_KIND)
    const doomed = new Set<string>()
    if (maxAgeDays > 0) {
      const cutoff = this.now().getTime() - maxAgeDays * 86_400_000
      for (const record of records) {
        const at = Date.parse(record.occurredAt)
        if (Number.isFinite(at) && at < cutoff) doomed.add(record.id)
      }
    }
    if (maxRecords > 0) {
      const survivors = records
        .filter(record => !doomed.has(record.id))
        .sort(compareNewestFirst)
      for (const record of survivors.slice(maxRecords)) doomed.add(record.id)
    }
    for (const id of doomed) this.store.deleteDoc(CONNECTOR_DOC_KIND, id)
    return doomed.size
  }

  private normalize(draft: ConnectorDraft, indexedAt: string): ConnectorRecord | undefined {
    if (!isGoogleService(draft.service)) return undefined
    if (!CONNECTOR_KINDS.includes(draft.kind)) return undefined
    if (typeof draft.externalId !== 'string' || !draft.externalId.trim()) return undefined
    const occurredAt = isoOrUndefined(draft.occurredAt)
    const updatedAt = isoOrUndefined(draft.updatedAt)
    if (!occurredAt || !updatedAt) return undefined
    return {
      id: connectorRecordId(draft.service, draft.externalId.trim()),
      service: draft.service,
      kind: draft.kind,
      externalId: draft.externalId.trim(),
      title: this.redact(draft.title),
      text: this.redact(draft.text),
      occurredAt,
      updatedAt,
      indexedAt,
      ...(draft.url ? { url: this.redact(draft.url) } : {}),
      ...(draft.participants?.length
        ? { participants: draft.participants.map(value => this.redact(value)) }
        : {}),
      ...(draft.labels?.length ? { labels: [...draft.labels] } : {}),
      ...(draft.wake === true ? { wake: true } : {}),
      ...(draft.wakeReason ? { wakeReason: oneLineText(this.redact(draft.wakeReason)) } : {}),
    }
  }
}

function sameRecord(left: ConnectorRecord, right: ConnectorRecord): boolean {
  return left.updatedAt === right.updatedAt
    && left.title === right.title
    && left.text === right.text
    && left.wake === right.wake
    && left.wakeReason === right.wakeReason
}

function scoreRecord(record: ConnectorRecord, tokens: readonly string[]): number {
  const title = new Set(canonicalTokens(record.title))
  const body = new Set(canonicalTokens([
    record.text,
    ...(record.participants ?? []),
    ...(record.labels ?? []),
  ].join(' ')))
  let score = 0
  for (const token of tokens) {
    if (title.has(token)) score += 3
    else if (body.has(token)) score += 1
  }
  return score
}

function compareScored(left: Scored, right: Scored): number {
  return right.score - left.score
    || right.record.occurredAt.localeCompare(left.record.occurredAt)
    || right.record.id.localeCompare(left.record.id)
}

function compareNewestFirst(left: ConnectorRecord, right: ConnectorRecord): number {
  return right.occurredAt.localeCompare(left.occurredAt)
    || right.updatedAt.localeCompare(left.updatedAt)
    || right.id.localeCompare(left.id)
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 10
  return Math.max(1, Math.min(100, Math.trunc(limit)))
}

function parseBound(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined
  const at = Date.parse(value)
  if (!Number.isFinite(at)) throw new UserError(`connector query ${field} must be an ISO date`)
  return at
}

function isoOrUndefined(value: string): string | undefined {
  const at = Date.parse(value)
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined
}

function oneLineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

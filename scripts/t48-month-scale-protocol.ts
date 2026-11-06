/**
 * T48 month-scale LTM measurement — offline fixture smoke.
 *
 * This script exercises the measurement hooks for the month-scale protocol in
 * `docs/T48_MONTH_SCALE_PROTOCOL.md`. It writes a small corpus with `createdAt`
 * values months apart through the store's injectable clock, advances the clock
 * past the hot retention window, and then measures:
 *
 *   - cold-tier recall@3 after the hot entries were pruned;
 *   - cold digest survival (every archived Thread has a digest);
 *   - ACL enforcement before/after recall grants;
 *   - the semantic arm's contribution with the shipped HashedEmbedding;
 *   - determinism across repeated queries and a reopened store.
 *
 * The dates are synthetic. This is a smoke test of the measurement path, NOT
 * a calendar-month run and NOT evidence that T48 is complete. No wall-clock
 * sleep, network call, or live model is involved.
 *
 * Run: pnpm t48:smoke
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readSpillFor } from '../src/memory/acl.ts'
import { DEFAULT_EMBEDDING_FLOOR, EMBEDDING_DIMS, HashedEmbedding } from '../src/memory/embedding.ts'
import { threadRef } from '../src/memory/graph.ts'
import {
  SpillBackedLongTermMemory,
  type LongTermMemoryEntry,
} from '../src/memory/long-term.ts'
import { Store } from '../src/store/sqlite.ts'

/** Retention values matching the Runtime defaults in `memoryRetentionFromEnv({})`. */
export const FIXTURE_RETENTION = {
  maxEntries: 1000,
  maxAgeDays: 90,
  coldMaxEntries: 200,
  coldMaxAgeDays: 3650,
} as const

/** Reader ticket used for recall and ACL checks. */
export const FIXTURE_READER = 'ticket_month_reader'

/** One synthetic observation month per corpus entry (UTC noon). */
export const SYNTHETIC_MONTHS = [
  '2026-01-15T12:00:00.000Z',
  '2026-02-15T12:00:00.000Z',
  '2026-03-15T12:00:00.000Z',
  '2026-04-15T12:00:00.000Z',
] as const

/** The clock is advanced here, more than 90 days after the last corpus entry. */
export const OBSERVATION_DATE = '2026-07-15T12:00:00.000Z'

export interface FixtureEntry {
  thread: string
  text: string
  createdAt: string
}

/**
 * Four topics, one per synthetic month. Each entry carries a Thread ref so the
 * pruner can fold it into exactly one cold digest. The last topic is written
 * with no lexical overlap against its query, so only the semantic arm can
 * retrieve it.
 */
export const FIXTURE_CORPUS: readonly FixtureEntry[] = [
  {
    thread: 'billing',
    text: 'invoice csv rejected blank rows',
    createdAt: SYNTHETIC_MONTHS[0],
  },
  {
    thread: 'gateway',
    text: 'gateway bearer token rotated after incident',
    createdAt: SYNTHETIC_MONTHS[1],
  },
  {
    thread: 'deploy',
    text: 'deploy pipeline paused during incident review',
    createdAt: SYNTHETIC_MONTHS[2],
  },
  {
    thread: 'semantic-topic',
    text: 'idempotency key rejected',
    createdAt: SYNTHETIC_MONTHS[3],
  },
]

export interface ProtocolQuery {
  id: string
  text: string
  relevantThread: string
}

export const PROTOCOL_QUERIES: readonly ProtocolQuery[] = [
  { id: 'billing', text: 'invoice csv rejected blank rows', relevantThread: 'billing' },
  { id: 'gateway', text: 'gateway bearer token rotated', relevantThread: 'gateway' },
  { id: 'deploy', text: 'deploy pipeline incident review', relevantThread: 'deploy' },
  // Canonical tokens differ from the stored body; cosine 0.516 with
  // HashedEmbedding clears the default 0.35 floor.
  { id: 'semantic', text: 'idempotent keys', relevantThread: 'semantic-topic' },
]

export interface QueryResult {
  id: string
  text: string
  relevantThread: string
  rankedThreads: string[]
  recallAt3: number
}

export interface T48ProtocolReport {
  kind: 't48-fixture-smoke'
  /** Explicit: synthetic dates are not calendar-month evidence. */
  synthetic: true
  completionEvidence: false
  syntheticMonths: readonly string[]
  observationDate: string
  environment: {
    node: string
    platform: string
    embedding: string
    embeddingDimensions: number
    embeddingFloor: number
    retention: typeof FIXTURE_RETENTION
  }
  metrics: {
    corpusEntries: number
    hotEntriesBeforePrune: number
    hotEntriesAfterPrune: number
    hotEntriesPruned: number
    coldDigests: number
    digestSurvival: number
    coldRecallAt3: number
    semanticLexicalHits: number
    semanticHybridHits: number
    semanticArmContribution: number
    aclEnforcedBeforeRecall: boolean
    aclGrantedAfterRecall: boolean
    aclStillEnforcedForOtherReaders: boolean
    deterministicWithinSession: boolean
    deterministicAfterReopen: boolean
  }
  queries: QueryResult[]
}

interface Measured {
  report: Omit<T48ProtocolReport, 'metrics'> & {
    metrics: Omit<T48ProtocolReport['metrics'], 'deterministicAfterReopen'>
  }
  firstRunIds: Map<string, string[]>
}

function threadOf(entry: LongTermMemoryEntry, known: ReadonlySet<string>): string | undefined {
  return (entry.tags ?? []).find(tag => known.has(tag))
}

function throws(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

/** First pass: write, prune, measure recall/ACL/semantic arm, record ids. */
function measure(home: string): Measured {
  const knownThreads = new Set(FIXTURE_CORPUS.map(entry => entry.thread))
  const store = new Store(home)
  try {
    const embedding = new HashedEmbedding()
    let clock = new Date(FIXTURE_CORPUS[0].createdAt)
    const memory = new SpillBackedLongTermMemory(store, {
      ...FIXTURE_RETENTION,
      now: () => clock,
      embedding,
      embeddingFloor: DEFAULT_EMBEDDING_FLOOR,
    })

    for (const doc of FIXTURE_CORPUS) {
      clock = new Date(doc.createdAt)
      memory.put(`ticket_${doc.thread}`, doc.text, {
        tags: [doc.thread],
        refs: [threadRef(doc.thread)],
      })
    }
    const hotEntriesBeforePrune = store.listDocs<LongTermMemoryEntry>('ltm')
      .filter(entry => (entry.tier ?? 'hot') === 'hot').length

    // A write at the observation date drives the retention prune. Every corpus
    // entry is now older than 90 days, so each one is archived and deleted.
    clock = new Date(OBSERVATION_DATE)
    memory.put('ticket_fresh_window', 'fresh note written after the synthetic observation window', {
      tags: ['fresh'],
      refs: [threadRef('fresh')],
    })

    const afterPrune = store.listDocs<LongTermMemoryEntry>('ltm')
    const hotAfterPrune = afterPrune.filter(entry => (entry.tier ?? 'hot') === 'hot')
    const hotTicketsAfterPrune = new Set(hotAfterPrune.map(entry => entry.ticketId))
    const hotEntriesPruned = FIXTURE_CORPUS
      .filter(doc => !hotTicketsAfterPrune.has(`ticket_${doc.thread}`)).length
    const coldDigests = afterPrune.filter(entry => entry.tier === 'cold' && entry.kind === 'digest')
    const digestByThread = new Map<string, LongTermMemoryEntry>()
    for (const digest of coldDigests) {
      const thread = threadOf(digest, knownThreads)
      if (thread) digestByThread.set(thread, digest)
    }

    // ACL is checked before any reader query grants access to a digest spill.
    const billingDigest = digestByThread.get('billing')
    assert.ok(billingDigest, 'billing digest must survive the hot prune')
    const aclEnforcedBeforeRecall = throws(() =>
      readSpillFor(store, billingDigest.spillId, { ticketId: FIXTURE_READER }))

    const runQueries = (): { results: QueryResult[]; ids: Map<string, string[]> } => {
      const results: QueryResult[] = []
      const ids = new Map<string, string[]>()
      for (const query of PROTOCOL_QUERIES) {
        const hits = memory.query({
          ticketId: FIXTURE_READER,
          text: query.text,
          tier: 'cold',
          limit: 3,
        })
        ids.set(query.id, hits.map(entry => entry.id))
        const rankedThreads = hits
          .map(entry => threadOf(entry, knownThreads))
          .filter((thread): thread is string => thread != null)
        results.push({
          id: query.id,
          text: query.text,
          relevantThread: query.relevantThread,
          rankedThreads,
          recallAt3: rankedThreads.slice(0, 3).includes(query.relevantThread) ? 1 : 0,
        })
      }
      return { results, ids }
    }

    const first = runQueries()

    const aclGrantedAfterRecall = !throws(() =>
      readSpillFor(store, billingDigest.spillId, { ticketId: FIXTURE_READER }))
    const aclStillEnforcedForOtherReaders = throws(() =>
      readSpillFor(store, billingDigest.spillId, { ticketId: 'ticket_unrelated_reader' }))

    // The semantic query has no lexical overlap. Measure the same store twice:
    // once with the port and once without, so the arm's contribution is visible.
    const semanticQuery = PROTOCOL_QUERIES.find(query => query.id === 'semantic')
    assert.ok(semanticQuery, 'the protocol must define a semantic query')
    const lexicalOnly = new SpillBackedLongTermMemory(store)
    const semanticLexicalHits = lexicalOnly.query({
      ticketId: 'ticket_lexical_only_reader',
      text: semanticQuery.text,
      tier: 'cold',
      limit: 10,
    }).length
    const semanticHybridHits = memory.query({
      ticketId: 'ticket_hybrid_reader',
      text: semanticQuery.text,
      tier: 'cold',
      limit: 10,
    }).length

    const second = runQueries()
    const deterministicWithinSession = PROTOCOL_QUERIES.every(query =>
      JSON.stringify(second.ids.get(query.id)) === JSON.stringify(first.ids.get(query.id)))

    const archivedThreads = FIXTURE_CORPUS.map(entry => entry.thread)
    const survivingThreads = archivedThreads.filter(thread => digestByThread.has(thread))
    const coldRecallAt3 = first.results.reduce((sum, result) => sum + result.recallAt3, 0)
      / first.results.length

    return {
      report: {
        kind: 't48-fixture-smoke',
        synthetic: true,
        completionEvidence: false,
        syntheticMonths: SYNTHETIC_MONTHS,
        observationDate: OBSERVATION_DATE,
        environment: {
          node: process.version,
          platform: `${process.platform} ${process.arch}`,
          embedding: embedding.id,
          embeddingDimensions: EMBEDDING_DIMS,
          embeddingFloor: DEFAULT_EMBEDDING_FLOOR,
          retention: FIXTURE_RETENTION,
        },
        metrics: {
          corpusEntries: FIXTURE_CORPUS.length,
          hotEntriesBeforePrune,
          hotEntriesAfterPrune: hotAfterPrune.length,
          hotEntriesPruned,
          coldDigests: coldDigests.length,
          digestSurvival: survivingThreads.length / archivedThreads.length,
          coldRecallAt3,
          semanticLexicalHits,
          semanticHybridHits,
          semanticArmContribution: semanticHybridHits - semanticLexicalHits,
          aclEnforcedBeforeRecall,
          aclGrantedAfterRecall,
          aclStillEnforcedForOtherReaders,
          deterministicWithinSession,
        },
        queries: first.results,
      },
      firstRunIds: first.ids,
    }
  } finally {
    store.close()
  }
}

/** Second pass: reopen the same SQLite file and require identical query ids. */
function verifyReopen(home: string, firstRunIds: Map<string, string[]>): boolean {
  const reopened = new Store(home)
  try {
    const memory = new SpillBackedLongTermMemory(reopened, {
      ...FIXTURE_RETENTION,
      now: () => new Date(OBSERVATION_DATE),
      embedding: new HashedEmbedding(),
      embeddingFloor: DEFAULT_EMBEDDING_FLOOR,
    })
    return PROTOCOL_QUERIES.every(query => {
      const ids = memory.query({
        ticketId: FIXTURE_READER,
        text: query.text,
        tier: 'cold',
        limit: 3,
      }).map(entry => entry.id)
      assert.ok(ids.every(id => reopened.getDoc('ltm', id) != null), 'query returned a missing entry')
      return JSON.stringify(ids) === JSON.stringify(firstRunIds.get(query.id))
    })
  } finally {
    reopened.close()
  }
}

/**
 * Run the full fixture smoke. `home` is for tests that want to inspect the
 * database; without it a temporary directory is created and removed.
 */
export function runT48MonthScaleProtocol(options: { home?: string } = {}): T48ProtocolReport {
  const ownsHome = options.home == null
  const home = options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-t48-'))
  try {
    const measured = measure(home)
    const deterministicAfterReopen = verifyReopen(home, measured.firstRunIds)
    const report: T48ProtocolReport = {
      ...measured.report,
      metrics: {
        ...measured.report.metrics,
        deterministicAfterReopen,
      },
    }
    assert.equal(report.metrics.hotEntriesPruned, FIXTURE_CORPUS.length, 'every aged hot entry must be pruned')
    assert.equal(report.metrics.digestSurvival, 1, 'every archived Thread must have a cold digest')
    assert.equal(report.metrics.coldRecallAt3, 1, 'every labelled cold query must hit in the top 3')
    assert.equal(report.metrics.semanticLexicalHits, 0, 'the semantic fixture query must be lexically unreachable')
    assert.ok(report.metrics.semanticArmContribution > 0, 'the semantic arm must contribute a hybrid hit')
    assert.equal(report.metrics.aclEnforcedBeforeRecall, true, 'a digest spill must not be readable before recall')
    assert.equal(report.metrics.aclGrantedAfterRecall, true, 'recall must grant the reader the hit spill')
    assert.equal(report.metrics.aclStillEnforcedForOtherReaders, true, 'recall must not grant unrelated readers')
    assert.equal(report.metrics.deterministicWithinSession, true, 'repeated queries must be deterministic')
    assert.equal(report.metrics.deterministicAfterReopen, true, 'a reopened store must return the same ids')
    return report
  } finally {
    if (ownsHome) fs.rmSync(home, { recursive: true, force: true })
  }
}

function main(): void {
  const report = runT48MonthScaleProtocol()
  console.log('T48 month-scale LTM protocol — offline fixture smoke (synthetic clock)')
  console.log('This is NOT a calendar-month measurement and NOT completion evidence.')
  console.log(`- synthetic months: ${report.syntheticMonths.join(', ')}`)
  console.log(`- observation date: ${report.observationDate}`)
  console.log(`- hot entries: ${report.metrics.hotEntriesBeforePrune} -> ${report.metrics.hotEntriesAfterPrune}`)
  console.log(`- cold digests: ${report.metrics.coldDigests} (survival ${report.metrics.digestSurvival})`)
  console.log(`- cold recall@3: ${report.metrics.coldRecallAt3}`)
  console.log(`- semantic arm: lexical ${report.metrics.semanticLexicalHits}, hybrid ${report.metrics.semanticHybridHits}`)
  console.log(`- ACL enforced: ${report.metrics.aclEnforcedBeforeRecall}, granted after recall: ${report.metrics.aclGrantedAfterRecall}`)
  console.log(`- deterministic: within session ${report.metrics.deterministicWithinSession}, after reopen ${report.metrics.deterministicAfterReopen}`)
  console.log('')
  console.log(JSON.stringify(report, null, 2))
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === entry) main()

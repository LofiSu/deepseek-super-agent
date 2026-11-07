import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readSpillFor } from '../memory/acl.ts'
import { DEFAULT_EMBEDDING_FLOOR, HashedEmbedding } from '../memory/embedding.ts'
import { threadRef } from '../memory/graph.ts'
import {
  SpillBackedLongTermMemory,
  type LongTermMemoryEntry,
} from '../memory/long-term.ts'
import { Store } from '../store/sqlite.ts'
import {
  FIXTURE_CORPUS,
  FIXTURE_READER,
  FIXTURE_RETENTION,
  PROTOCOL_QUERIES,
  type ProtocolQuery,
} from '../../scripts/t48-month-scale-protocol.ts'

/** Deterministic incremental inserts; one row per wall-clock / scheduled sample. */
export const T48_INCREMENTAL_SAMPLES = FIXTURE_CORPUS

/** Held-out queries stable across samples (full protocol query set). */
export const T48_HELD_OUT_QUERIES: readonly ProtocolQuery[] = PROTOCOL_QUERIES

export const T48_CORPUS_STATE_REL = '.ds-agent/measurement/t48-corpus-state.json'

export interface T48CorpusState {
  schemaVersion: 1
  home: string
  insertedSampleIndices: number[]
  firstInsertAt?: string
  lastInsertAt?: string
}

export function corpusStatePath(home: string): string {
  return path.join(home, T48_CORPUS_STATE_REL)
}

export function readCorpusState(home: string): T48CorpusState | undefined {
  const file = corpusStatePath(home)
  if (!fs.existsSync(file)) return undefined
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T48CorpusState
}

export function writeCorpusState(state: T48CorpusState): void {
  fs.mkdirSync(path.dirname(corpusStatePath(state.home)), { recursive: true })
  fs.writeFileSync(corpusStatePath(state.home), `${JSON.stringify(state, null, 0)}\n`, 'utf8')
}

function retentionForMode(env: NodeJS.ProcessEnv): {
  maxEntries: number
  maxAgeDays: number
  coldMaxEntries: number
  coldMaxAgeDays: number
} {
  let retention: {
    maxEntries: number
    maxAgeDays: number
    coldMaxEntries: number
    coldMaxAgeDays: number
  } = { ...FIXTURE_RETENTION }
  const testMaxAgeDays = env.DS_AGENT_T48_TEST_HOT_MAX_AGE_DAYS?.trim()
  if (testMaxAgeDays != null && testMaxAgeDays.length > 0) {
    const days = Number(testMaxAgeDays)
    if (Number.isFinite(days) && days >= 0) {
      retention = { ...retention, maxAgeDays: days }
    }
  }
  const testMaxEntries = env.DS_AGENT_T48_TEST_HOT_MAX_ENTRIES?.trim()
  if (testMaxEntries != null && testMaxEntries.length > 0) {
    const n = Number(testMaxEntries)
    if (Number.isFinite(n) && n >= 1) {
      retention = { ...retention, maxEntries: n }
    }
  }
  return retention
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

export interface T48IncrementalReport {
  kind: 't48-persistent-incremental'
  /** Fixture text/topics only — never user data. */
  syntheticWorkload: true
  /** False when sample uses synthetic injected clock; true for real elapsed `createdAt`. */
  wallClockMeasurement: boolean
  completionEvidence: false
  sampleIndex: number
  insertedThread: string | null
  corpusSamplesTotal: number
  recordedAt: string
  environment: {
    node: string
    platform: string
    embedding: string
    retention: ReturnType<typeof retentionForMode>
  }
  metrics: {
    insertedSamples: number
    hotEntries: number
    coldDigests: number
    coldRecallAt3ForInserted: number
    heldOutQueryRecall: Array<{ id: string, recallAt3: number, rankedThreads: string[] }>
    unrelatedQueryHits: number
    topBillingQueryIsBilling: boolean
    oldestInsertedAgeMs: number | null
    deterministicAfterReopen: boolean
  }
}

export interface T48IncrementalStepResult {
  runId: string
  state: T48CorpusState
  report: T48IncrementalReport
  /** Same store path after close — for callers verifying persistence. */
  home: string
}

/**
 * One deterministic incremental sample against a persistent SQLite store under `home`.
 * Reopens the store each call; accumulates fixture rows across invocations (and process boundaries).
 */
export function runT48PersistentIncrementalStep(options: {
  home: string
  wallClockMeasurement: boolean
  /** Injectable clock for synthetic measurement mode only. */
  now?: () => Date
  env?: NodeJS.ProcessEnv
  forceInsert?: boolean
}): T48IncrementalStepResult {
  const env = options.env ?? process.env
  const wallClock = options.wallClockMeasurement
  const knownThreads = new Set(T48_INCREMENTAL_SAMPLES.map(e => e.thread))
  const prior = readCorpusState(options.home)
  const inserted = new Set(prior?.insertedSampleIndices ?? [])
  const nextIndex = T48_INCREMENTAL_SAMPLES.findIndex((_, i) => !inserted.has(i))

  let currentTime = wallClock ? new Date() : (options.now?.() ?? new Date())
  const clock = (): Date => currentTime

  const retention = retentionForMode(env)
  const store = new Store(options.home)
  const runId = randomUUID()
  try {
    const embedding = new HashedEmbedding()
    const memory = new SpillBackedLongTermMemory(store, {
      ...retention,
      now: () => clock(),
      embedding,
      embeddingFloor: DEFAULT_EMBEDDING_FLOOR,
    })

    let insertedThread: string | null = null
    if (nextIndex >= 0 && (options.forceInsert !== false)) {
      const doc = T48_INCREMENTAL_SAMPLES[nextIndex]!
      if (!wallClock) {
        currentTime = new Date(doc.createdAt)
      }
      const at = clock()
      memory.put(`ticket_${doc.thread}`, doc.text, {
        tags: [doc.thread],
        refs: [threadRef(doc.thread)],
      })
      inserted.add(nextIndex)
      insertedThread = doc.thread
      const state: T48CorpusState = {
        schemaVersion: 1,
        home: options.home,
        insertedSampleIndices: [...inserted].sort((a, b) => a - b),
        firstInsertAt: prior?.firstInsertAt ?? at.toISOString(),
        lastInsertAt: at.toISOString(),
      }
      writeCorpusState(state)
    }

    // Drive hot prune once entire corpus is present (wall-clock or synthetic path).
    if (inserted.size === T48_INCREMENTAL_SAMPLES.length) {
      if (!wallClock) {
        currentTime = new Date(T48_INCREMENTAL_SAMPLES[T48_INCREMENTAL_SAMPLES.length - 1]!.createdAt)
        currentTime = new Date(currentTime.getTime() + 120 * 86_400_000)
      }
      memory.put('ticket_fresh_window', 'fresh note after incremental corpus complete', {
        tags: ['fresh'],
        refs: [threadRef('fresh')],
      })
    }

    const state: T48CorpusState = readCorpusState(options.home) ?? {
      schemaVersion: 1,
      home: options.home,
      insertedSampleIndices: [...inserted].sort((a, b) => a - b),
    }

    const after = store.listDocs<LongTermMemoryEntry>('ltm')
    const hotEntries = after.filter(e => (e.tier ?? 'hot') === 'hot').length
    const coldDigests = after.filter(e => e.tier === 'cold' && e.kind === 'digest').length

    const heldOutQueryRecall: T48IncrementalReport['metrics']['heldOutQueryRecall'] = []
    let recallSum = 0
    let recallCount = 0
    for (const query of T48_HELD_OUT_QUERIES) {
      const sampleIndex = T48_INCREMENTAL_SAMPLES.findIndex(s => s.thread === query.relevantThread)
      if (sampleIndex < 0 || !inserted.has(sampleIndex)) continue
      const hits = memory.query({
        ticketId: FIXTURE_READER,
        text: query.text,
        tier: 'cold',
        limit: 3,
      })
      const rankedThreads = hits
        .map(e => threadOf(e, knownThreads))
        .filter((t): t is string => t != null)
      const recallAt3 = rankedThreads.slice(0, 3).includes(query.relevantThread) ? 1 : 0
      heldOutQueryRecall.push({ id: query.id, recallAt3, rankedThreads })
      recallSum += recallAt3
      recallCount += 1
    }
    const coldRecallAt3ForInserted = recallCount > 0 ? recallSum / recallCount : 0

    const unrelatedHits = memory.query({
      ticketId: 'ticket_contamination_probe',
      text: 'totally unrelated quantum pizza topology',
      tier: 'cold',
      limit: 3,
    }).length

    const billingTop = memory.query({
      ticketId: FIXTURE_READER,
      text: 'invoice csv rejected blank rows',
      tier: 'cold',
      limit: 1,
    })[0]
    const topBillingQueryIsBilling = inserted.has(0)
      ? (billingTop?.tags ?? []).includes('billing')
      : false

    let oldestInsertedAgeMs: number | null = null
    if (state.firstInsertAt) {
      oldestInsertedAgeMs = Math.max(0, clock().getTime() - Date.parse(state.firstInsertAt))
    }

    const billingDigest = after.find(
      e => e.tier === 'cold' && e.kind === 'digest' && e.tags?.includes('billing'),
    )
    if (billingDigest && inserted.has(0)) {
      void throws(() => readSpillFor(store, billingDigest.spillId, { ticketId: FIXTURE_READER }))
    }

    const firstIds = new Map<string, string[]>()
    for (const query of T48_HELD_OUT_QUERIES) {
      if (!inserted.has(T48_INCREMENTAL_SAMPLES.findIndex(s => s.thread === query.relevantThread))) continue
      const hits = memory.query({
        ticketId: FIXTURE_READER,
        text: query.text,
        tier: 'cold',
        limit: 3,
      })
      firstIds.set(query.id, hits.map(h => h.id))
    }
    store.close()

    const reopened = new Store(options.home)
    try {
      const memory2 = new SpillBackedLongTermMemory(reopened, {
        ...retention,
        now: () => clock(),
        embedding: new HashedEmbedding(),
        embeddingFloor: DEFAULT_EMBEDDING_FLOOR,
      })
      const deterministicAfterReopen = [...firstIds.entries()].every(([id, ids]) => {
        const query = T48_HELD_OUT_QUERIES.find(q => q.id === id)
        if (!query) return true
        const again = memory2.query({
          ticketId: FIXTURE_READER,
          text: query.text,
          tier: 'cold',
          limit: 3,
        }).map(h => h.id)
        return JSON.stringify(again) === JSON.stringify(ids)
      })

      const recordedAt = clock().toISOString()
      const report: T48IncrementalReport = {
        kind: 't48-persistent-incremental',
        syntheticWorkload: true,
        wallClockMeasurement: wallClock,
        completionEvidence: false,
        sampleIndex: state.insertedSampleIndices.length,
        insertedThread,
        corpusSamplesTotal: T48_INCREMENTAL_SAMPLES.length,
        recordedAt,
        environment: {
          node: process.version,
          platform: `${process.platform} ${process.arch}`,
          embedding: embedding.id,
          retention,
        },
        metrics: {
          insertedSamples: state.insertedSampleIndices.length,
          hotEntries,
          coldDigests,
          coldRecallAt3ForInserted,
          heldOutQueryRecall,
          unrelatedQueryHits: unrelatedHits,
          topBillingQueryIsBilling,
          oldestInsertedAgeMs,
          deterministicAfterReopen,
        },
      }
      return { runId, state, report, home: options.home }
    } finally {
      reopened.close()
    }
  } finally {
    store.close()
  }
}


import { describe, expect, it, vi } from 'vitest'
import { SpillBackedLongTermMemory, type LongTermMemoryEntry } from '../src/memory/long-term.ts'
import { Store } from '../src/store/sqlite.ts'
import { tempHome } from './fixtures.ts'

/**
 * Offline, deterministic evaluation of the shipped long-term memory recall
 * path (`SpillBackedLongTermMemory.query`) after ADR-010.
 *
 * The corpus is fixed and every entry is already redacted (fixtures only, no
 * secrets). `query()` is exercised through an on-disk SQLite store exactly like
 * `test/long-term-memory.test.ts`: no network, no model, no sleeps, no live
 * channel, no wall-clock assertion.
 *
 * Metric: recall@3 is the fraction of each query's labelled relevant entries
 * that appear in the top three results. The reported macro value is the mean
 * over positive queries. ADR-010 recorded the pre-implementation baseline at
 * 4/11 = 0.364; the implementation assertions below measure the shipped path.
 */

type Category = 'exact' | 'paraphrase' | 'morphology' | 'word-order' | 'tag-only' | 'multi-hop'

const CATEGORIES: readonly Category[] = [
  'exact', 'paraphrase', 'morphology', 'word-order', 'tag-only', 'multi-hop',
]

interface EvalDoc {
  key: string
  text: string
  tags: string[]
}

interface EvalQuery {
  id: string
  category: Category
  text: string
  /** Keys from CORPUS. Multi-hop queries label every entry needed to answer. */
  relevant: string[]
  tags?: string[]
}

interface RankedQuery {
  query: EvalQuery
  ranked: string[]
  recall: number
}

/**
 * Realistic redacted entries. Names, paths, and ticket ids are fixtures; the
 * text resembles the summaries `remember()` and `put()` persist after redaction.
 */
const CORPUS: readonly EvalDoc[] = [
  {
    key: 'gateway-401',
    text: 'Gateway returned 401 after the local bearer token was rotated; restarting the agent re-read gateway.token and cleared the failure.',
    tags: ['gateway', 'auth'],
  },
  {
    key: 'billing-export',
    text: 'Monthly billing export failed because the invoice CSV contained an empty customer id; validation now rejects blank rows.',
    tags: ['billing', 'export'],
  },
  {
    key: 'ltm-retention',
    text: 'Long-term memory retention prunes entries older than ninety days and keeps at most one thousand; the cap is configurable with environment variables.',
    tags: ['memory', 'retention'],
  },
  {
    key: 'deploy-owner',
    text: 'The platform team owns the deploy pipeline and approves changes to the production release job.',
    tags: ['deploy', 'ownership'],
  },
  {
    key: 'deploy-token',
    text: 'The deploy token was rotated on 2026-10-30 after the incident review; old credentials no longer work.',
    tags: ['deploy', 'security'],
  },
  {
    key: 'sandbox-missing',
    text: 'Bash commands fail closed when the sandbox wrapper is absent; operators must install sandbox-exec or set an explicit opt-out.',
    tags: ['sandbox', 'env'],
  },
  {
    key: 'memory-recall',
    text: 'Recall uses word AND substring matching over redacted summaries; synonyms and paraphrases are not expanded.',
    tags: ['memory', 'recall'],
  },
  {
    key: 'imessage-group',
    text: 'iMessage group chats are denied unless the operator supplies an allowlist and explicitly enables groups.',
    tags: ['imessage', 'admission'],
  },
  {
    key: 'gateway-latency',
    text: 'Gateway latency rose when upstream retries queued without a bound; a bounded retry queue restored p95.',
    tags: ['gateway', 'performance'],
  },
  {
    key: 'outbox-retry',
    text: 'Outbox delivery retries transient send errors with exponential backoff and marks permanent failures without retry.',
    tags: ['outbox', 'delivery'],
  },
  {
    key: 'memory-acl',
    text: 'A long-term memory id is not a capability; recall grants the reader ticket access to the spill body.',
    tags: ['memory', 'acl'],
  },
  {
    key: 'feishu-thread',
    text: 'Feishu replies stay in the originating thread and use the chat id from the inbound message.',
    tags: ['feishu', 'thread'],
  },
  {
    key: 'semantic-eval',
    text: 'An offline evaluation corpus measures recall at three for lexical, tag expansion, and embedding strategies.',
    tags: ['memory', 'evaluation'],
  },
  {
    key: 'deploy-incident',
    text: 'Production release paused after the deploy pipeline incident; the platform team restored the previous build.',
    tags: ['deploy', 'incident'],
  },
]

/** The 11 original ADR-010 queries; expectations are unchanged. */
const POSITIVE_QUERIES: readonly EvalQuery[] = [
  // Exact lexical match: every query word is spelled the same way in one body.
  {
    id: 'exact-gateway',
    category: 'exact',
    text: 'gateway 401 bearer token rotated',
    relevant: ['gateway-401'],
  },
  {
    id: 'exact-billing',
    category: 'exact',
    text: 'billing export invoice CSV empty customer id',
    relevant: ['billing-export'],
  },
  // Paraphrase/synonym and morphology: the intent matches, the tokens do not.
  {
    id: 'paraphrase-credential',
    category: 'paraphrase',
    text: 'gateway credential rotation',
    relevant: ['gateway-401'],
  },
  {
    id: 'paraphrase-synonyms',
    category: 'paraphrase',
    text: 'recall does not expand synonyms or paraphrases',
    relevant: ['memory-recall'],
  },
  {
    id: 'paraphrase-morphology',
    category: 'paraphrase',
    text: 'retention pruning old entries',
    relevant: ['ltm-retention'],
  },
  // Word order: all words exist, but not in the stored order.
  {
    id: 'order-gateway',
    category: 'word-order',
    text: 'rotated token bearer gateway 401',
    relevant: ['gateway-401'],
  },
  {
    id: 'order-billing',
    category: 'word-order',
    text: 'customer empty CSV invoice export billing',
    relevant: ['billing-export'],
  },
  // Tag-only: the word is metadata, not body text.
  {
    id: 'tag-security',
    category: 'tag-only',
    text: 'security',
    relevant: ['deploy-token'],
  },
  {
    id: 'tag-admission',
    category: 'tag-only',
    text: 'admission',
    relevant: ['imessage-group'],
  },
  // Multi-hop: one or both answers require following a shared tag between two
  // entries (deploy-owner and deploy-token/deploy-incident share `deploy`).
  {
    id: 'multi-hop-deploy-token',
    category: 'multi-hop',
    text: 'who owns the deploy pipeline whose token was rotated',
    relevant: ['deploy-owner', 'deploy-token'],
  },
  {
    id: 'multi-hop-deploy-incident',
    category: 'multi-hop',
    text: 'which team owns the deploy pipeline and restored the production release after the incident',
    relevant: ['deploy-owner', 'deploy-incident'],
  },
]

/**
 * Held-out queries, authored in this PR after the implementation was in place.
 * They are additional coverage, not a blind or independent generalization set;
 * they exercise paraphrase, morphology, tag-only, and multi-hop recall over the
 * same fixed corpus.
 */
const HELD_OUT_QUERIES: readonly EvalQuery[] = [
  {
    id: 'held-exact-latency',
    category: 'exact',
    text: 'bounded retry queue restored p95',
    relevant: ['gateway-latency'],
  },
  {
    id: 'held-exact-outbox',
    category: 'exact',
    text: 'outbox delivery exponential backoff permanent failures',
    relevant: ['outbox-retry'],
  },
  {
    id: 'held-paraphrase-latency',
    category: 'paraphrase',
    text: 'gateway delay from upstream retry queue',
    relevant: ['gateway-latency'],
  },
  {
    id: 'held-paraphrase-sandbox',
    category: 'paraphrase',
    text: 'missing sandbox wrapper fails closed',
    relevant: ['sandbox-missing'],
  },
  {
    id: 'held-paraphrase-retention',
    category: 'paraphrase',
    text: 'memory retention removes old entries',
    relevant: ['ltm-retention'],
  },
  {
    id: 'held-morphology-rotation',
    category: 'morphology',
    text: 'credential rotation for gateway',
    relevant: ['gateway-401'],
  },
  {
    id: 'held-morphology-retries',
    category: 'morphology',
    text: 'outbox retried transient errors',
    relevant: ['outbox-retry'],
  },
  {
    id: 'held-morphology-auth',
    category: 'morphology',
    text: 'gateway authentication failures',
    relevant: ['gateway-401'],
  },
  {
    id: 'held-tag-acl',
    category: 'tag-only',
    text: 'acl',
    relevant: ['memory-acl'],
  },
  {
    id: 'held-tag-env',
    category: 'tag-only',
    text: 'env',
    relevant: ['sandbox-missing'],
  },
  {
    id: 'held-tag-performance',
    category: 'tag-only',
    text: 'performance',
    relevant: ['gateway-latency'],
  },
  {
    id: 'held-hop-deploy',
    category: 'multi-hop',
    text: 'deploy token rotation owner approval',
    relevant: ['deploy-owner', 'deploy-token'],
  },
  {
    id: 'held-hop-incident',
    category: 'multi-hop',
    text: 'production release incident team deploy',
    relevant: ['deploy-owner', 'deploy-incident'],
  },
  {
    id: 'held-hop-gateway',
    category: 'multi-hop',
    text: 'gateway token rotation latency',
    relevant: ['gateway-401', 'gateway-latency'],
  },
  {
    id: 'held-hop-memory',
    category: 'multi-hop',
    text: 'memory retention recall synonyms',
    relevant: ['ltm-retention', 'memory-recall'],
  },
]

const NEGATIVE_QUERIES: readonly string[] = [
  'kubernetes helm chart',
  'payment refund chargeback',
]

const HELD_OUT_NEGATIVE_QUERIES: readonly string[] = [
  'solar eclipse photography',
  'quantum telescope calibration',
]

interface Seeded {
  home: string
  store: Store
  memory: SpillBackedLongTermMemory
  keyById: Map<string, string>
}

/**
 * Injected clock keeps createdAt and the id-desc tie-breaker stable. Retention
 * is left at the constructor default (disabled) so the fixed corpus is intact;
 * runtime defaults are covered by the 1000-entry fixture and ADR-010.
 */
function seedCorpus(): Seeded {
  const home = tempHome()
  const store = new Store(home)
  let tick = 0
  const memory = new SpillBackedLongTermMemory(store, {
    now: () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1_000),
  })
  const keyById = new Map<string, string>()
  for (const doc of CORPUS) {
    const entry = memory.put(`ticket_${doc.key}`, doc.text, { tags: doc.tags })
    keyById.set(entry.id, doc.key)
  }
  return { home, store, memory, keyById }
}

/** The real shipped path: `query()` on the persisted store. */
function queryRanks(seeded: Seeded, query: EvalQuery): string[] {
  return seeded.memory.query({
    ticketId: 'ticket_reader',
    text: query.text,
    tags: query.tags,
    limit: 3,
  }).map((entry: LongTermMemoryEntry) => seeded.keyById.get(entry.id) ?? entry.id)
}

function queryIds(memory: SpillBackedLongTermMemory, query: EvalQuery): string[] {
  return memory.query({
    ticketId: 'ticket_reader',
    text: query.text,
    tags: query.tags,
    limit: 3,
  }).map(entry => entry.id)
}

function coverage(ranked: readonly string[], relevant: readonly string[]): number {
  const top = new Set(ranked.slice(0, 3))
  return relevant.filter(key => top.has(key)).length / relevant.length
}

function evaluate(
  queries: readonly EvalQuery[],
  rank: (query: EvalQuery) => string[],
): { macro: number; byCategory: Record<Category, number>; results: RankedQuery[] } {
  const results = queries.map(query => {
    const ranked = rank(query)
    return { query, ranked, recall: coverage(ranked, query.relevant) }
  })
  const byCategory = Object.fromEntries(CATEGORIES.map(category => {
    const inCategory = results.filter(result => result.query.category === category)
    const mean = inCategory.length
      ? inCategory.reduce((sum, result) => sum + result.recall, 0) / inCategory.length
      : 0
    return [category, mean]
  })) as Record<Category, number>
  const macro = results.reduce((sum, result) => sum + result.recall, 0) / results.length
  return { macro, byCategory, results }
}

describe('Long-term memory recall evaluation (offline)', () => {
  it('meets the original 11-query acceptance criteria through query()', () => {
    const seeded = seedCorpus()
    try {
      const evaluation = evaluate(POSITIVE_QUERIES, query => queryRanks(seeded, query))

      // ADR-010 floor is 10/11; the targeted outcome is 11/11.
      expect(evaluation.macro).toBeGreaterThanOrEqual(10 / 11)
      expect(evaluation.macro).toBe(1)
      expect(evaluation.byCategory.exact).toBe(1)
      expect(evaluation.byCategory['word-order']).toBe(1)
      expect(evaluation.byCategory['tag-only']).toBeGreaterThanOrEqual(0.5)
      expect(evaluation.byCategory['multi-hop']).toBeGreaterThanOrEqual(0.5)
      // Targeted outcomes, not just the floor.
      expect(evaluation.byCategory.paraphrase).toBe(1)
      expect(evaluation.byCategory['tag-only']).toBe(1)
      expect(evaluation.byCategory['multi-hop']).toBe(1)
    } finally {
      seeded.store.close()
    }
  })

  it('meets the held-out query targets through query()', () => {
    const seeded = seedCorpus()
    try {
      const evaluation = evaluate(HELD_OUT_QUERIES, query => queryRanks(seeded, query))

      expect(HELD_OUT_QUERIES.length).toBeGreaterThanOrEqual(10)
      expect(evaluation.macro).toBe(1)
      expect(evaluation.byCategory.exact).toBe(1)
      expect(evaluation.byCategory.paraphrase).toBe(1)
      expect(evaluation.byCategory.morphology).toBe(1)
      expect(evaluation.byCategory['tag-only']).toBe(1)
      expect(evaluation.byCategory['multi-hop']).toBe(1)
    } finally {
      seeded.store.close()
    }
  })

  it('returns zero for both negative controls and held-out precision controls', () => {
    const seeded = seedCorpus()
    try {
      for (const text of [...NEGATIVE_QUERIES, ...HELD_OUT_NEGATIVE_QUERIES]) {
        expect(seeded.memory.query({
          ticketId: 'ticket_reader',
          text,
          limit: 3,
        })).toEqual([])
      }
    } finally {
      seeded.store.close()
    }
  })

  it('is deterministic across repeated query() runs and a reopened SQLite store', () => {
    const allQueries = [...POSITIVE_QUERIES, ...HELD_OUT_QUERIES]
    const first = seedCorpus()
    let firstIds: string[][] = []
    let repeatedIds: string[][] = []
    try {
      firstIds = allQueries.map(query => queryIds(first.memory, query))
      repeatedIds = allQueries.map(query => queryIds(first.memory, query))
    } finally {
      first.store.close()
    }
    expect(repeatedIds).toEqual(firstIds)

    const reopened = new Store(first.home)
    try {
      const memory = new SpillBackedLongTermMemory(reopened)
      const reopenedIds = allQueries.map(query => queryIds(memory, query))
      expect(reopenedIds).toEqual(firstIds)
    } finally {
      reopened.close()
    }
  })

  it('remains bounded and deterministic on a 1000-entry fixture', () => {
    const home = tempHome()
    const store = new Store(home)
    let tick = 0
    const memory = new SpillBackedLongTermMemory(store, {
      now: () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1_000),
    })
    store.atomic(() => {
      for (let index = 0; index < 1000; index += 1) {
        memory.put(`ticket_bulk_${index}`, `bulk note number ${index}`, { tags: ['bulk'] })
      }
    })
    expect(store.listDocs('ltm')).toHaveLength(1000)

    const spillReads = vi.spyOn(store, 'getSpill')
    let firstIds: string[] = []
    try {
      const first = memory.query({ ticketId: 'ticket_reader', text: 'bulk', limit: 5 })
      firstIds = first.map(entry => entry.id)
      expect(first).toHaveLength(5)
      // One readable body per retention-bounded entry; the hop index cannot
      // cause a second scan or an unbounded walk.
      expect(spillReads.mock.calls.length).toBeLessThanOrEqual(1000)

      const repeated = memory.query({ ticketId: 'ticket_reader', text: 'bulk', limit: 5 })
      expect(repeated.map(entry => entry.id)).toEqual(firstIds)
      expect(spillReads.mock.calls.length).toBeLessThanOrEqual(2000)
    } finally {
      spillReads.mockRestore()
      store.close()
    }

    const reopened = new Store(home)
    try {
      const reopenedMemory = new SpillBackedLongTermMemory(reopened)
      expect(reopenedMemory.query({
        ticketId: 'ticket_reader',
        text: 'bulk',
        limit: 5,
      }).map(entry => entry.id)).toEqual(firstIds)
    } finally {
      reopened.close()
    }
  })
})

import { describe, expect, it } from 'vitest'
import { SpillBackedLongTermMemory, type LongTermMemoryEntry } from '../src/memory/long-term.ts'
import { Store } from '../src/store/sqlite.ts'
import { tempHome } from './fixtures.ts'

/**
 * Offline, deterministic evaluation of long-term memory recall.
 *
 * The corpus is fixed and every entry is already redacted (fixtures only, no
 * secrets). The real `query()` path is exercised through an in-memory/temp
 * SQLite store exactly like `test/long-term-memory.test.ts`: no network, no
 * model, no sleeps, no live channel.
 *
 * Metric: recall@3 is the fraction of each query's labelled relevant entries
 * that appear in the top three results. The reported macro value is the mean
 * over positive queries. Category means are reported separately because the
 * baseline's failures are not uniform (see ADR-010).
 */

type Category = 'exact' | 'paraphrase' | 'word-order' | 'tag-only' | 'multi-hop'

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
  // entries (deploy-owner and deploy-token/deploy-incident share the `deploy` tag).
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

const NEGATIVE_QUERIES: readonly string[] = [
  'kubernetes helm chart',
  'payment refund chargeback',
]

interface Seeded {
  home: string
  store: Store
  memory: SpillBackedLongTermMemory
  keyById: Map<string, string>
  docs: EvalDoc[]
}

/**
 * Injected clock keeps createdAt and the id-desc tie-breaker stable. Retention
 * is left at the constructor default (disabled) so the fixed corpus is intact;
 * runtime defaults are evaluated in ADR-010, not changed here.
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
  const docs = memory.recent(CORPUS.length).map(entry => ({
    key: keyById.get(entry.id) ?? entry.id,
    text: store.getSpill(entry.spillId) ?? '',
    tags: entry.tags ?? [],
  }))
  return { home, store, memory, keyById, docs }
}

function baselineRank(seeded: Seeded, query: EvalQuery): string[] {
  return seeded.memory.query({
    ticketId: 'ticket_reader',
    text: query.text,
    tags: query.tags,
    limit: 3,
  }).map((entry: LongTermMemoryEntry) => seeded.keyById.get(entry.id) ?? entry.id)
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
  const categories: Category[] = ['exact', 'paraphrase', 'word-order', 'tag-only', 'multi-hop']
  const byCategory = Object.fromEntries(categories.map(category => {
    const inCategory = results.filter(result => result.query.category === category)
    const mean = inCategory.length
      ? inCategory.reduce((sum, result) => sum + result.recall, 0) / inCategory.length
      : 0
    return [category, mean]
  })) as Record<Category, number>
  const macro = results.reduce((sum, result) => sum + result.recall, 0) / results.length
  return { macro, byCategory, results }
}

// ---------------------------------------------------------------------------
// Candidate strategies. These are evaluation-only implementations over the
// same redacted corpus; no product source is imported or changed.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'did', 'do', 'does', 'for',
  'from', 'how', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'was', 'were',
  'what', 'when', 'where', 'which', 'who', 'whose', 'why', 'with',
])

/**
 * Small in-repo synonym/morphology map. The canonical form is the first word
 * in each group. It is deliberately tiny and deterministic: no model, no
 * learned vocabulary, no external dependency.
 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['token', 'credential', 'credentials'],
  ['rotate', 'rotated', 'rotates', 'rotating', 'rotation'],
  ['prune', 'prunes', 'pruned', 'pruning'],
  ['old', 'older', 'oldest'],
  ['entry', 'entries'],
  ['fail', 'failed', 'failing', 'failure', 'failures'],
  ['expand', 'expanded', 'expands', 'expansion'],
  ['synonym', 'synonyms'],
  ['paraphrase', 'paraphrases'],
  ['own', 'owns', 'owned', 'owner', 'ownership'],
  ['restore', 'restored', 'restores'],
  ['deploy', 'deploys', 'deployed', 'deployment'],
  ['release', 'releases', 'released'],
  ['incident', 'incidents'],
  ['auth', 'authentication', 'authenticate'],
  ['memory', 'memories'],
  ['retention', 'retain', 'retains', 'retained'],
  ['measure', 'measures', 'measured'],
  ['evaluate', 'evaluation', 'evaluates'],
  ['embed', 'embedding', 'embeddings'],
]

const CANONICAL = new Map<string, string>()
for (const group of SYNONYM_GROUPS) {
  const canonical = group[0]!
  for (const word of group) CANONICAL.set(word, canonical)
}

function tokenize(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function queryTokens(text: string): string[] {
  return [...new Set(tokenize(text)
    .map(token => CANONICAL.get(token) ?? token)
    .filter(token => !STOPWORDS.has(token)))]
}

function byScoreThenKey(a: { key: string; score: number }, b: { key: string; score: number }): number {
  return b.score - a.score || a.key.localeCompare(b.key)
}

/** (a) Lexical normalization + synonym/morphology map, keeping AND semantics. */
function lexicalAndRank(docs: readonly EvalDoc[], text: string): string[] {
  const words = queryTokens(text)
  if (!words.length) return []
  return docs.flatMap(doc => {
    const body = new Set(tokenize(doc.text).map(token => CANONICAL.get(token) ?? token))
    const hits = words.filter(word => body.has(word)).length
    return hits === words.length ? [{ key: doc.key, score: hits }] : []
  }).sort(byScoreThenKey).map(item => item.key)
}

/** (b) Tag-aware OR scoring plus one-hop expansion across shared tags. */
function tagHoppedScores(
  docs: readonly EvalDoc[],
  text: string,
  requestedTags: readonly string[] = [],
): Map<string, number> {
  const words = queryTokens(text)
  const wanted = requestedTags.map(tag => CANONICAL.get(tag.toLowerCase()) ?? tag.toLowerCase())
  const bodyTokens = new Map(docs.map(doc => [
    doc.key,
    new Set(tokenize(doc.text).map(token => CANONICAL.get(token) ?? token)),
  ]))
  const tagTokens = new Map(docs.map(doc => [
    doc.key,
    new Set(doc.tags.map(tag => CANONICAL.get(tag.toLowerCase()) ?? tag.toLowerCase())),
  ]))
  const direct = new Map<string, number>()
  for (const doc of docs) {
    const body = bodyTokens.get(doc.key)!
    const tags = tagTokens.get(doc.key)!
    let score = words.filter(word => body.has(word)).length
    score += words.filter(word => tags.has(word)).length
    score += wanted.filter(tag => tags.has(tag)).length * 2
    if (score > 0) direct.set(doc.key, score)
  }
  const scores = new Map(direct)
  for (const [seedKey, seedScore] of direct) {
    const seedTags = tagTokens.get(seedKey)!
    if (!seedTags.size) continue
    for (const doc of docs) {
      if (doc.key === seedKey) continue
      const tags = tagTokens.get(doc.key)!
      const sharesTag = [...seedTags].some(tag => tags.has(tag))
      if (sharesTag) scores.set(doc.key, (scores.get(doc.key) ?? 0) + seedScore * 0.5)
    }
  }
  return scores
}

function tagHoppedRank(docs: readonly EvalDoc[], text: string, requestedTags: readonly string[] = []): string[] {
  return [...tagHoppedScores(docs, text, requestedTags).entries()]
    .map(([key, score]) => ({ key, score }))
    .sort(byScoreThenKey)
    .map(item => item.key)
}

type SparseVector = ReadonlyMap<string, number>

/** (c) Pluggable embedding port. The mock is offline, deterministic, token-only. */
interface EmbeddingPort {
  readonly name: string
  embed(text: string): SparseVector
}

class DeterministicMockEmbedding implements EmbeddingPort {
  readonly name = 'deterministic-mock'

  embed(text: string): SparseVector {
    const counts = new Map<string, number>()
    for (const token of queryTokens(text)) {
      counts.set(token, (counts.get(token) ?? 0) + 1)
    }
    const norm = Math.sqrt([...counts.values()].reduce((sum, value) => sum + value * value, 0))
    if (!norm) return new Map()
    return new Map([...counts].map(([token, count]) => [token, count / norm]))
  }
}

function cosine(left: SparseVector, right: SparseVector): number {
  let dot = 0
  for (const [token, weight] of left) {
    dot += weight * (right.get(token) ?? 0)
  }
  return dot
}

function embeddingRank(docs: readonly EvalDoc[], port: EmbeddingPort, text: string): string[] {
  const query = port.embed(text)
  return docs.map(doc => ({
    key: doc.key,
    score: cosine(query, port.embed(`${doc.text} ${doc.tags.join(' ')}`)),
  })).filter(item => item.score > 0).sort(byScoreThenKey).map(item => item.key)
}

/** (d) Hybrid: normalized tag-hop lexical score plus mock-embedding cosine. */
function hybridRank(docs: readonly EvalDoc[], port: EmbeddingPort, text: string): string[] {
  const lexical = tagHoppedScores(docs, text)
  const maxLexical = Math.max(0, ...lexical.values())
  const query = port.embed(text)
  return docs.map(doc => {
    const lexicalScore = (lexical.get(doc.key) ?? 0) / (maxLexical || 1)
    const embeddingScore = cosine(query, port.embed(`${doc.text} ${doc.tags.join(' ')}`))
    return { key: doc.key, score: lexicalScore + embeddingScore }
  }).filter(item => item.score > 0).sort(byScoreThenKey).map(item => item.key)
}

describe('Long-term memory recall evaluation (offline)', () => {
  it('pins the current lexical baseline at 4/11 macro recall@3', () => {
    const seeded = seedCorpus()
    try {
      const baseline = evaluate(POSITIVE_QUERIES, query => baselineRank(seeded, query))

      expect(baseline.macro).toBeCloseTo(4 / 11, 10)
      expect(baseline.byCategory).toEqual({
        exact: 1,
        paraphrase: 0,
        'word-order': 1,
        'tag-only': 0,
        'multi-hop': 0,
      })

      // Explicit per-query evidence for the categories the baseline loses.
      for (const result of baseline.results) {
        if (result.query.category === 'multi-hop') expect(result.recall).toBe(0)
        if (result.query.category === 'tag-only') expect(result.ranked).toEqual([])
        if (result.query.category === 'paraphrase') expect(result.recall).toBe(0)
      }
    } finally {
      seeded.store.close()
    }
  })

  it('measures the candidate strategies on the same fixed corpus', () => {
    const seeded = seedCorpus()
    try {
      const mock = new DeterministicMockEmbedding()
      const normalized = evaluate(POSITIVE_QUERIES, query => lexicalAndRank(seeded.docs, query.text))
      const tagHopped = evaluate(POSITIVE_QUERIES, query => tagHoppedRank(seeded.docs, query.text, query.tags))
      const embedded = evaluate(POSITIVE_QUERIES, query => embeddingRank(seeded.docs, mock, query.text))
      const hybrid = evaluate(POSITIVE_QUERIES, query => hybridRank(seeded.docs, mock, query.text))

      // (a) Normalization + synonym map recovers paraphrase/morphology only.
      expect(normalized.macro).toBeCloseTo(7 / 11, 10)
      expect(normalized.byCategory).toEqual({
        exact: 1,
        paraphrase: 1,
        'word-order': 1,
        'tag-only': 0,
        'multi-hop': 0,
      })

      // (b) One-hop tag expansion recovers tag-only and multi-hop as well.
      expect(tagHopped.macro).toBe(1)
      expect(tagHopped.byCategory).toEqual({
        exact: 1,
        paraphrase: 1,
        'word-order': 1,
        'tag-only': 1,
        'multi-hop': 1,
      })
      for (const result of tagHopped.results) {
        if (result.query.category === 'multi-hop') expect(result.recall).toBe(1)
      }

      // (c) The deterministic mock embedding matches (b) on this corpus; it
      // shows no incremental recall, so it cannot justify a provider/dependency.
      expect(embedded.macro).toBe(1)

      // (d) Hybrid ranking also matches (b); no measured gain for the extra layer.
      expect(hybrid.macro).toBe(1)
    } finally {
      seeded.store.close()
    }
  })

  it('returns no results for negative controls under every strategy', () => {
    const seeded = seedCorpus()
    try {
      const mock = new DeterministicMockEmbedding()
      const rankers: ((text: string) => string[])[] = [
        text => baselineRank(seeded, { id: 'negative', category: 'exact', text, relevant: [] }),
        text => lexicalAndRank(seeded.docs, text),
        text => tagHoppedRank(seeded.docs, text),
        text => embeddingRank(seeded.docs, mock, text),
        text => hybridRank(seeded.docs, mock, text),
      ]
      for (const text of NEGATIVE_QUERIES) {
        for (const rank of rankers) expect(rank(text)).toEqual([])
      }
    } finally {
      seeded.store.close()
    }
  })

  it('is deterministic across repeated runs and a reopened SQLite store', () => {
    const first = seedCorpus()
    let firstRanks: string[][] = []
    try {
      firstRanks = POSITIVE_QUERIES.map(query => baselineRank(first, query))
    } finally {
      first.store.close()
    }

    const reopened = new Store(first.home)
    try {
      const memory = new SpillBackedLongTermMemory(reopened)
      const idToKey = new Map(memory.recent(CORPUS.length).map(entry => [
        entry.id,
        entry.ticketId.replace(/^ticket_/u, ''),
      ]))
      const secondRanks = POSITIVE_QUERIES.map(query => memory.query({
        ticketId: 'ticket_reader',
        text: query.text,
        tags: query.tags,
        limit: 3,
      }).map(entry => idToKey.get(entry.id) ?? entry.id))
      expect(secondRanks).toEqual(firstRanks)
    } finally {
      reopened.close()
    }
  })
})

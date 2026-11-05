import { describe, expect, it } from 'vitest'
import { cosine, HashedEmbedding, type EmbeddingPort } from '../src/memory/embedding.ts'
import { SpillBackedLongTermMemory } from '../src/memory/long-term.ts'
import { readSpillFor } from '../src/memory/acl.ts'
import { Store } from '../src/store/sqlite.ts'
import { embeddingFloorFromEnv, semanticRecallEnabled } from '../src/runtime.ts'
import { freshRuntime, shutdown, tempHome } from './fixtures.ts'

/**
 * Semantic recall is optional: without an EmbeddingPort the shipped lexical
 * behavior is unchanged. With a port, hybrid ranking adds entries whose body
 * has no lexical overlap but whose vector is close enough. Every hit still goes
 * through the same spill ACL grant.
 */

class FixedEmbedding implements EmbeddingPort {
  readonly id = 'test-fixed'
  constructor(private readonly vectors: Readonly<Record<string, readonly number[]>>) {}
  embed(text: string): readonly number[] {
    return this.vectors[text] ?? [0, 0]
  }
}

const launch = 'launch moved to friday'
const billing = 'invoice csv rejected blank rows'
const vectors = new FixedEmbedding({
  [launch]: [1, 0],
  [billing]: [0, 1],
  'when is the ship window': [0.95, 0.05],
  'unrelated question': [0, 1],
})

function norm(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
}

describe('HashedEmbedding', () => {
  it('is deterministic and unit length', () => {
    const embedding = new HashedEmbedding()
    const first = embedding.embed('deployment pipeline failed')
    const second = embedding.embed('deployment pipeline failed')
    expect(second).toEqual(first)
    // Stored values are rounded to five decimals, so unit length is approximate.
    expect(norm(first)).toBeCloseTo(1, 4)
    expect(embedding.id).toMatch(/\S/)
  })

  it('keeps related wording closer than unrelated wording', () => {
    const embedding = new HashedEmbedding()
    const anchor = embedding.embed('deployment pipeline failed')
    const related = embedding.embed('deploying the pipeline broke')
    const unrelated = embedding.embed('invoice csv rejected blank rows')
    expect(cosine(anchor, related)).toBeGreaterThan(cosine(anchor, unrelated))
  })

  it('maps empty or punctuation-only text to a zero vector', () => {
    const embedding = new HashedEmbedding()
    expect(embedding.embed('').every(value => value === 0)).toBe(true)
    expect(embedding.embed(' ... ').every(value => value === 0)).toBe(true)
  })
})

describe('cosine', () => {
  it('handles identical, orthogonal, and zero vectors', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 10)
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10)
    expect(cosine([0, 0], [1, 0])).toBe(0)
  })

  it('rejects vectors of different dimensions', () => {
    expect(() => cosine([1, 0], [1, 0, 0])).toThrow(/dimension/i)
  })
})

describe('semantic configuration', () => {
  it('parses the kill switch and the floor from the environment', () => {
    expect(semanticRecallEnabled({})).toBe(true)
    for (const value of ['0', 'false', 'OFF', ' no ']) {
      expect(semanticRecallEnabled({ DS_AGENT_SEMANTIC_RECALL: value })).toBe(false)
    }
    expect(semanticRecallEnabled({ DS_AGENT_SEMANTIC_RECALL: '1' })).toBe(true)
    // An explicit programmatic port wins over a stale kill switch.
    expect(semanticRecallEnabled({ DS_AGENT_SEMANTIC_RECALL: '0' }, vectors)).toBe(true)
    expect(semanticRecallEnabled({}, false)).toBe(false)

    expect(embeddingFloorFromEnv({ DS_AGENT_EMBEDDING_FLOOR: '0.5' })).toBe(0.5)
    expect(embeddingFloorFromEnv({ DS_AGENT_EMBEDDING_FLOOR: 'nope' })).toBeCloseTo(0.35)
    expect(embeddingFloorFromEnv({ DS_AGENT_EMBEDDING_FLOOR: '2' })).toBe(1)
    expect(embeddingFloorFromEnv({ DS_AGENT_EMBEDDING_FLOOR: '-1' })).toBe(0)
    expect(embeddingFloorFromEnv({}, 0.42)).toBe(0.42)
  })
})

describe('semantic recall', () => {
  it('finds a memory with no shared lexical token above the floor', () => {
    const store = new Store(tempHome())
    const memory = new SpillBackedLongTermMemory(store, {
      embedding: vectors,
      embeddingFloor: 0.8,
    })
    const saved = memory.put('ticket_a', launch)
    memory.put('ticket_a', billing)

    const hits = memory.query({ ticketId: 'reader', text: 'when is the ship window' })
    expect(hits.map(entry => entry.id)).toEqual([saved.id])
    expect(readSpillFor(store, saved.spillId, { ticketId: 'reader' }).text).toBe(launch)
    store.close()
  })

  it('does not run when no embedding port is configured', () => {
    const store = new Store(tempHome())
    const memory = new SpillBackedLongTermMemory(store)
    memory.put('ticket_a', launch)
    expect(memory.query({ ticketId: 'reader', text: 'when is the ship window' })).toEqual([])
    store.close()
  })

  it('does not return entries below the floor', () => {
    const store = new Store(tempHome())
    const memory = new SpillBackedLongTermMemory(store, {
      embedding: vectors,
      embeddingFloor: 0.8,
    })
    memory.put('ticket_a', billing)
    expect(memory.query({ ticketId: 'reader', text: 'when is the ship window' })).toEqual([])
    store.close()
  })

  it('persists embeddings and lazily fills entries written before the port existed', () => {
    const home = tempHome()
    const first = new Store(home)
    const lexicalOnly = new SpillBackedLongTermMemory(first)
    const saved = lexicalOnly.put('ticket_a', launch)
    expect(first.getDoc<{ embedding?: number[] }>('ltm', saved.id)?.embedding).toBeUndefined()
    first.close()

    const second = new Store(home)
    const semantic = new SpillBackedLongTermMemory(second, {
      embedding: vectors,
      embeddingFloor: 0.8,
    })
    expect(semantic.query({ ticketId: 'reader', text: 'when is the ship window' })
      .map(entry => entry.id)).toEqual([saved.id])
    expect(second.getDoc<{ embedding?: number[] }>('ltm', saved.id)?.embedding).toEqual([1, 0])
    second.close()
  })

  it('recalls semantic-only text with the shipped embedding', () => {
    const store = new Store(tempHome())
    const memory = new SpillBackedLongTermMemory(store, { embedding: new HashedEmbedding() })
    const saved = memory.put('ticket_a', 'idempotency key rejected')
    // No shared canonical token: idempotency/idempotent and key/keys are not
    // in the synonym table, so only the vector path can retrieve this.
    expect(memory.query({ ticketId: 'reader', text: 'idempotent keys' })
      .map(entry => entry.id)).toEqual([saved.id])
    store.close()
  })

  it('indexes the head so a long report cannot dilute the title match', () => {
    const store = new Store(tempHome())
    const memory = new SpillBackedLongTermMemory(store, { embedding: new HashedEmbedding() })
    const report = Array.from({ length: 30 }, (_, index) => `line ${index} unrelated billing detail`)
    const saved = memory.put('ticket_a', ['idempotency key rejected', ...report].join('\n'))
    expect(memory.query({ ticketId: 'reader', text: 'idempotent keys' })
      .map(entry => entry.id)).toEqual([saved.id])
    store.close()
  })

  it('degrades to lexical recall when the embedding provider throws', () => {
    const store = new Store(tempHome())
    const exploding: EmbeddingPort = {
      id: 'exploding',
      embed: () => { throw new Error('provider down') },
    }
    const memory = new SpillBackedLongTermMemory(store, { embedding: exploding })
    const saved = memory.put('ticket_a', 'invoice csv rejected blank rows')
    expect(memory.query({ ticketId: 'reader', text: 'blank invoice rows' })
      .map(entry => entry.id)).toEqual([saved.id])
    expect(memory.query({ ticketId: 'reader', text: 'idempotent keys' })).toEqual([])
    store.close()
  })

  it('rejects an unrelated query with the shipped embedding and default floor', () => {
    const store = new Store(tempHome())
    const memory = new SpillBackedLongTermMemory(store, { embedding: new HashedEmbedding() })
    memory.put('ticket_a', 'invoice csv rejected blank rows')
    expect(memory.query({ ticketId: 'reader', text: 'deployment pipeline failed' })).toEqual([])
    store.close()
  })

  it('is on by default in the Runtime and can be switched off', async () => {
    const on = freshRuntime({ jobDelayMs: 0, watchdogIntervalMs: 60_000 })
    try {
      const saved = on.longTermMemory.put('ticket_a', 'deployment pipeline failed')
      expect(on.store.getDoc<{ embedding?: number[] }>('ltm', saved.id)?.embedding?.length)
        .toBeGreaterThan(0)
    } finally {
      await shutdown(on)
    }

    const off = freshRuntime({ jobDelayMs: 0, watchdogIntervalMs: 60_000, embeddings: false })
    try {
      const saved = off.longTermMemory.put('ticket_a', 'deployment pipeline failed')
      expect(off.store.getDoc<{ embedding?: number[] }>('ltm', saved.id)?.embedding).toBeUndefined()
    } finally {
      await shutdown(off)
    }
  })

  it('lets the Runtime tune the semantic floor', async () => {
    const strict = freshRuntime({
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      embeddings: vectors,
      embeddingFloor: 1,
    })
    try {
      strict.longTermMemory.put('ticket_a', launch)
      expect(strict.longTermMemory.query({ ticketId: 'reader', text: 'when is the ship window' }))
        .toEqual([])
    } finally {
      await shutdown(strict)
    }

    const loose = freshRuntime({
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      embeddings: vectors,
      embeddingFloor: 0.9,
    })
    try {
      loose.longTermMemory.put('ticket_a', launch)
      expect(loose.longTermMemory.query({ ticketId: 'reader', text: 'when is the ship window' }))
        .toHaveLength(1)
    } finally {
      await shutdown(loose)
    }
  })

  it('keeps lexical recall unchanged when the port is present', () => {
    const store = new Store(tempHome())
    const memory = new SpillBackedLongTermMemory(store, {
      embedding: vectors,
      embeddingFloor: 0.99,
    })
    const saved = memory.put('ticket_a', billing)
    expect(memory.query({ ticketId: 'reader', text: 'blank invoice rows' })
      .map(entry => entry.id)).toEqual([saved.id])
    store.close()
  })
})

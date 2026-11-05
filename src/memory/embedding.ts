/**
 * Optional semantic recall. An EmbeddingPort turns text into a fixed-length,
 * L2-normalized vector; the shipped HashedEmbedding is deterministic, offline,
 * and dependency-free, so tests and CI never call a model or provider.
 *
 * The port is deliberately tiny: providers can wrap a local model, a hosted
 * embedding API, or a cached table without changing the memory store.
 */
export interface EmbeddingPort {
  /** Stable id persisted with each vector. A change invalidates old vectors. */
  readonly id: string
  embed(text: string): readonly number[]
}

/** Dimensions of the shipped hashed embedding. */
export const EMBEDDING_DIMS = 128

/** Cosine floor for semantic recall. Below this an entry is not a candidate. */
export const DEFAULT_EMBEDDING_FLOOR = 0.35

/**
 * Deterministic character-n-gram embedding. Each word becomes the trigrams of
 * its `#word#` form (short words become one gram), so "deploying" and
 * "deployment" overlap on their shared stem without any learned vocabulary.
 * Signed feature hashing keeps collisions from always adding weight.
 *
 * Text is NFKC-normalized and lower-cased, matching the lexical tokenizer.
 * Empty text maps to a zero vector; cosine() treats that as no similarity.
 */
export class HashedEmbedding implements EmbeddingPort {
  readonly id: string
  constructor(readonly dimensions = EMBEDDING_DIMS) {
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error('embedding dimensions must be a positive integer')
    }
    this.id = `hashed-v1:${dimensions}`
  }

  embed(text: string): readonly number[] {
    const vector = new Float64Array(this.dimensions)
    const words = text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    for (const word of words) {
      const wrapped = `#${word}#`
      const grams = wrapped.length <= 3
        ? [wrapped]
        : Array.from({ length: wrapped.length - 2 }, (_, index) => wrapped.slice(index, index + 3))
      // One unit per word, split across its grams. Identical words then have
      // cosine 1 and shared stems keep most of their overlap.
      const weight = 1 / Math.sqrt(grams.length)
      for (const gram of grams) {
        const hash = fnv1a(gram)
        const index = hash % this.dimensions
        vector[index]! += ((hash >>> 16) & 1) === 0 ? weight : -weight
      }
    }
    let length = 0
    for (const value of vector) length += value * value
    if (length === 0) return Array.from(vector)
    const scale = 1 / Math.sqrt(length)
    return Array.from(vector, value => Math.round(value * scale * 1e5) / 1e5)
  }
}

/** Dot-product cosine. Returns 0 when either vector is zero. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`embedding dimension mismatch: ${a.length} vs ${b.length}`)
  let dot = 0
  let left = 0
  let right = 0
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * b[index]!
    left += a[index]! * a[index]!
    right += b[index]! * b[index]!
  }
  if (left === 0 || right === 0) return 0
  return dot / Math.sqrt(left * right)
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

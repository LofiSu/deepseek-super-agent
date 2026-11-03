/**
 * Session affinity: a conversation stays on the provider/account that answered
 * it (mirrors Magpie's affinity.json). Bounded, in-process, insertion-ordered.
 */

export class Affinity {
  private readonly map = new Map<string, string>()

  constructor(private readonly limit = 5_000) {}

  get(sessionId: string): string | undefined {
    return this.map.get(sessionId)
  }

  set(sessionId: string, providerId: string): void {
    // Re-insert so the most recently used session is last (kept when trimming).
    this.map.delete(sessionId)
    this.map.set(sessionId, providerId)
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  size(): number {
    return this.map.size
  }
}

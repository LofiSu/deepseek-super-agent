import type { Trigger } from '../shared/types.ts'

/** One Router shard. Predicates live in `filter`; see `compileFilter`. */
export interface RouterShard {
  id: string
  /** `source:github,thread:pr/7` — comma joins predicates with AND. Default shard has no filter. */
  filter?: string
  /**
   * Higher runs first in `route`; ties keep registration order. The default
   * shard is always the fallback, regardless of this value.
   */
  priority?: number
}

interface ShardEntry {
  id: string
  priority: number
  matcher: (trigger: Trigger) => boolean
}

/**
 * Router sharding (T09/T46).
 *
 * Precedence: every matching non-default shard is returned, ordered by
 * `priority` descending and then by registration order. `default` is a
 * fallback only: it is returned when no other shard matches and is never
 * appended to a match list. `priority` on the default shard is ignored.
 *
 * Arbitration (P2-2): the first id in the returned list is the reply owner.
 * `Harness.routerTurn` targets that shard's session, and only that session may
 * call `reply_user`, `assess_trigger` stop/unavailable, or `stop_worker`.
 * Ownership is resolved from the trigger named by the call; a trigger/ticket
 * mismatch or a missing ticket/disposition is rejected. All matching shards run
 * their Router sessions against the same Ticket and Thread, so a shard cannot
 * create a second Ticket or emit a second terminal decision for one trigger.
 * `Evals.decide` also dedupes terminal outcomes per trigger.
 *
 * Shards are routing metadata, not multi-process placement: every shard's
 * session runs in this process.
 */
export class RouterShardRegistry {
  private readonly shards = new Map<string, ShardEntry>()

  register(shard: RouterShard): void {
    if (!shard.id.trim()) throw new Error('Router shard id must not be empty')
    if (shard.id === 'default' && shard.filter) throw new Error('Default router shard cannot have a filter')
    const matcher = shard.filter ? compileFilter(shard.filter) : () => true
    this.shards.set(shard.id, {
      id: shard.id,
      priority: Number.isFinite(shard.priority) ? shard.priority! : 0,
      matcher,
    })
  }

  unregister(id: string): boolean {
    if (id === 'default') return false
    return this.shards.delete(id)
  }

  get(id: string): RouterShard | undefined {
    const entry = this.shards.get(id)
    return entry ? { id: entry.id, priority: entry.priority } : undefined
  }

  list(): RouterShard[] {
    return [...this.shards.values()].map(entry => ({ id: entry.id, priority: entry.priority }))
  }

  /**
   * Ordered matches. A matching non-default shard always wins over `default`,
   * and the first element is the ticket's reply owner.
   */
  route(trigger: Trigger): string[] {
    const matches = [...this.shards.values()]
      // Stable sort: priority first, then registration order. `default` never
      // participates in the match list; it is the whole-list fallback below.
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.id !== 'default' && entry.matcher(trigger))
      .sort((a, b) => b.entry.priority - a.entry.priority || a.index - b.index)
      .map(({ entry }) => entry.id)
    return matches.length ? matches : ['default']
  }
}

/** Supported predicates: source, thread, actor, human, and text; comma joins with AND. */
function compileFilter(filter: string): (trigger: Trigger) => boolean {
  const predicates = filter.split(',').map(part => {
    const match = /^\s*(source|thread|actor|human|text)\s*[:=]\s*(\S(?:.*\S)?)\s*$/.exec(part)
    if (!match) throw new Error(`Invalid router shard filter: ${filter}`)
    const [, field, value] = match
    switch (field) {
      case 'source': return (trigger: Trigger) => trigger.source === value
      case 'thread': return (trigger: Trigger) => trigger.threads.some(thread => thread.id === value)
      case 'actor': return (trigger: Trigger) => trigger.actor.id === value
      case 'human': return (trigger: Trigger) => String(trigger.human) === value
      case 'text': return (trigger: Trigger) => trigger.text.includes(value)
      default: throw new Error(`Invalid router shard filter: ${filter}`)
    }
  })
  return trigger => predicates.every(predicate => predicate(trigger))
}

import type { Trigger } from '../shared/types.ts'

/** One Router shard. Predicates live in `filter`; see `compileFilter`. */
export interface RouterShard {
  id: string
  /** `source:github,thread:pr/7` — comma joins predicates with AND. Default shard has no filter. */
  filter?: string
  /** Higher runs first in `route`. Default shard is always the fallback, regardless of priority. */
  priority?: number
}

interface ShardEntry {
  id: string
  priority: number
  matcher: (trigger: Trigger) => boolean
}

/**
 * Router sharding (T09/T46): every matching non-default shard is returned in
 * priority order; a miss falls back to the default shard.
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

  route(trigger: Trigger): string[] {
    const matches = [...this.shards.values()]
      // Stable sort: priority first, then registration order.
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

import type { Trigger } from '../shared/types.ts'
import type { RouterShard } from './types.ts'

type Matcher = (trigger: Trigger) => boolean

/** An opt-in routing table. Filtered matches fan out; the default handles misses. */
export class RouterShardRegistry {
  private readonly shards = new Map<string, Matcher>()

  register(shard: RouterShard): void {
    if (!shard.id.trim()) throw new Error('Router shard id must not be empty')
    if (shard.id === 'default' && shard.filter) throw new Error('Default router shard cannot have a filter')
    const matcher = shard.filter ? compileFilter(shard.filter) : () => true
    this.shards.set(shard.id, matcher)
  }

  route(trigger: Trigger): string[] {
    const matches = [...this.shards]
      .filter(([id, matcher]) => id !== 'default' && matcher(trigger))
      .map(([id]) => id)
    return matches.length ? matches : ['default']
  }
}

/** Supported predicates: source, thread, actor, and text; comma joins with AND. */
function compileFilter(filter: string): Matcher {
  const predicates = filter.split(',').map(part => {
    const match = /^\s*(source|thread|actor|text)\s*[:=]\s*(\S(?:.*\S)?)\s*$/.exec(part)
    if (!match) throw new Error(`Invalid router shard filter: ${filter}`)
    const [, field, value] = match
    switch (field) {
      case 'source': return (trigger: Trigger) => trigger.source === value
      case 'thread': return (trigger: Trigger) => trigger.threads.some(thread => thread.id === value)
      case 'actor': return (trigger: Trigger) => trigger.actor.id === value
      case 'text': return (trigger: Trigger) => trigger.text.includes(value)
      default: throw new Error(`Invalid router shard filter: ${filter}`)
    }
  })
  return trigger => predicates.every(predicate => predicate(trigger))
}

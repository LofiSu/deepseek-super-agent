import type { Trigger } from '../shared/types.ts'

/** Source allow-list for one sequence point. `*` matches every source. */
export interface RouterShardFilter {
  sources: string[]
}

/**
 * One router sequence point.
 * `harness: 'in-process'` is the only binding this build starts.
 */
export interface RouterShard {
  id: string
  filter: RouterShardFilter
  harness: string
}

/**
 * `single` keeps one sequence point in this process (the default).
 * `sharded` only picks a shard id. It does not start another process.
 */
export interface RouterShardConfig {
  mode: 'single' | 'sharded'
  shards: RouterShard[]
}

const IN_PROCESS = 'in-process'

export function singleProcessShards(): RouterShardConfig {
  return {
    mode: 'single',
    shards: [{ id: 'router', filter: { sources: ['*'] }, harness: IN_PROCESS }],
  }
}

/** First matching shard wins. `single` always returns the first shard. */
export function selectShard(
  config: RouterShardConfig,
  trigger: Pick<Trigger, 'source' | 'id'>,
): RouterShard {
  const shards = config.shards.length > 0 ? config.shards : singleProcessShards().shards
  if (config.mode !== 'sharded') return shards[0]!
  const match = shards.find(shard => accepts(shard.filter, trigger.source))
  if (match) return match
  return shards[hash(trigger.id) % shards.length]!
}

function accepts(filter: RouterShardFilter, source: string): boolean {
  return filter.sources.includes('*') || filter.sources.includes(source)
}

function hash(id: string): number {
  let value = 0
  for (let i = 0; i < id.length; i += 1) value = (value * 33 + id.charCodeAt(i)) >>> 0
  return value
}

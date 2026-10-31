import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { selectShard, singleProcessShards, type RouterShardConfig } from '../src/router/shard.ts'
import type { Runtime } from '../src/runtime.ts'
import { freshRuntime, shutdown } from './fixtures.ts'

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

describe('router shards', () => {
  it('defaults to one in-process sequence point', () => {
    const config = singleProcessShards()
    expect(config.mode).toBe('single')
    expect(config.shards).toEqual([
      { id: 'router', filter: { sources: ['*'] }, harness: 'in-process' },
    ])
    expect(selectShard(config, { source: 'github', id: 'trg_1' }).id).toBe('router')
  })

  it('keeps single mode on the first shard', () => {
    const config: RouterShardConfig = {
      mode: 'single',
      shards: [
        { id: 'only', filter: { sources: ['*'] }, harness: 'in-process' },
        { id: 'other', filter: { sources: ['im'] }, harness: 'in-process' },
      ],
    }
    expect(selectShard(config, { source: 'im', id: 'trg_1' }).id).toBe('only')
  })

  it('selects a shard by source and stays in-process', () => {
    const config: RouterShardConfig = {
      mode: 'sharded',
      shards: [
        { id: 'im', filter: { sources: ['im'] }, harness: 'in-process' },
        { id: 'gh', filter: { sources: ['github'] }, harness: 'in-process' },
      ],
    }
    expect(selectShard(config, { source: 'im', id: 'trg_1' }).id).toBe('im')
    expect(selectShard(config, { source: 'github', id: 'trg_1' }).harness).toBe('in-process')
    const fallback = selectShard(config, { source: 'cli', id: 'trg_cli' })
    expect(['im', 'gh']).toContain(fallback.id)
    expect(selectShard(config, { source: 'cli', id: 'trg_cli' }).id).toBe(fallback.id)
  })

  it('logs the chosen shard without leaving the process', () => {
    runtime = freshRuntime({
      shards: {
        mode: 'sharded',
        shards: [
          { id: 'im', filter: { sources: ['im'] }, harness: 'in-process' },
          { id: 'gh', filter: { sources: ['github'] }, harness: 'in-process' },
        ],
      },
    })
    runtime.ingest(imTrigger({
      id: 'trg_noise',
      thread: 'topic/chatter',
      text: 'lol nice weather today haha',
      addressed: false,
    }))
    expect(runtime.log.text()).toContain('[router] shard=im mode=sharded harness=in-process')
  })
})

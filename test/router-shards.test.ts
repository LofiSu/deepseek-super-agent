import { describe, expect, it } from 'vitest'
import { githubTrigger } from '../src/channels/github.ts'
import { imTrigger } from '../src/channels/im.ts'
import { RouterShardRegistry } from '../src/ingress/shards.ts'

describe('Router shards', () => {
  it('routes to every matching shard and falls back to default', () => {
    const shards = new RouterShardRegistry()
    shards.register({ id: 'default' })
    shards.register({ id: 'github', filter: 'source:github' })
    shards.register({ id: 'pr-42', filter: 'thread:pr/42' })

    expect(shards.route(githubTrigger({ pr: 42, text: 'CI failed' }))).toEqual(['github', 'pr-42'])
    expect(shards.route(imTrigger({ thread: 'topic/chat', text: 'hello' }))).toEqual(['default'])
  })

  it('replaces a shard by id and rejects malformed filters', () => {
    const shards = new RouterShardRegistry()
    shards.register({ id: 'work', filter: 'source:github' })
    shards.register({ id: 'work', filter: 'source:im' })
    expect(shards.route(imTrigger({ thread: 'topic/chat', text: 'hello' }))).toEqual(['work'])
    expect(() => shards.register({ id: 'bad', filter: 'unsupported:value' })).toThrow()
  })

  it('matches combined predicates in priority order', () => {
    const shards = new RouterShardRegistry()
    shards.register({ id: 'ci', filter: 'source:github,thread:pr/7,text:failed' })
    shards.register({ id: 'first', filter: 'source:github', priority: 10 })
    expect(shards.route(githubTrigger({ pr: 7, text: 'CI failed' }))).toEqual(['first', 'ci'])
    expect(shards.route(githubTrigger({ pr: 8, text: 'CI failed' }))).toEqual(['first'])
  })
})

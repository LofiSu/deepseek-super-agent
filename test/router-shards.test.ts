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

  it('keeps registration order for equal priorities and omits default from matches', () => {
    const shards = new RouterShardRegistry()
    shards.register({ id: 'default', priority: 100 })
    shards.register({ id: 'first-equal', filter: 'source:im', priority: 5 })
    shards.register({ id: 'second-equal', filter: 'source:im', priority: 5 })
    shards.register({ id: 'third-equal', filter: 'source:im', priority: 5 })

    // Default is a fallback only, even with the highest priority.
    expect(shards.route(imTrigger({ thread: 'topic/equal', text: 'hello' }))).toEqual([
      'first-equal',
      'second-equal',
      'third-equal',
    ])
  })

  it('uses default only when no non-default shard matches', () => {
    const shards = new RouterShardRegistry()
    shards.register({ id: 'default' })
    shards.register({ id: 'github-only', filter: 'source:github' })

    expect(shards.route(imTrigger({ thread: 'topic/fallback', text: 'hello' }))).toEqual(['default'])
    expect(shards.route(githubTrigger({ pr: 3, text: 'CI failed' }))).toEqual(['github-only'])
  })

  it('runs a shard registered later first when its priority is higher', () => {
    const shards = new RouterShardRegistry()
    shards.register({ id: 'registered-first', filter: 'source:im', priority: 1 })
    shards.register({ id: 'registered-later', filter: 'source:im', priority: 10 })

    expect(shards.route(imTrigger({ thread: 'topic/later', text: 'hello' }))).toEqual([
      'registered-later',
      'registered-first',
    ])
  })

  it('returns every overlapping shard in arbitration order on one trigger', () => {
    const shards = new RouterShardRegistry()
    shards.register({ id: 'default' })
    shards.register({ id: 'thread-hit', filter: 'thread:topic/overlap', priority: 1 })
    shards.register({ id: 'text-hit', filter: 'text:timeout', priority: 3 })
    shards.register({ id: 'source-hit', filter: 'source:im', priority: 3 })

    expect(shards.route(imTrigger({
      thread: 'topic/overlap',
      text: 'the login timeout is back',
    }))).toEqual(['text-hit', 'source-hit', 'thread-hit'])
  })
})

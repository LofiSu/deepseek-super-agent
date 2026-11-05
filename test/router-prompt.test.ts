import { describe, expect, it } from 'vitest'
import { routerPromptFor } from '../src/harness/loop.ts'
import { directChatRouterShard, directChatThread, routerOwnerShard, routerSessionId, sharesDirectChatThread } from '../src/harness/session.ts'
import { systemPrompt } from '../src/harness/model.ts'
import type { Ticket } from '../src/shared/types.ts'

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'ticket_1',
    title: 'hello',
    brief: 'hello',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-v1',
      scope: 'hello',
      actor: { source: 'github', id: 'LofiSu' },
      basis: 'addressed',
    },
    threadKeys: ['github:issue:7'],
    channels: [{ source: 'github', thread: 'issue:7' }],
    inputs: [],
    assignments: [{ id: 'asg_1', state: 'running', speculative: false }],
    speculative: false,
    originTriggerId: 'trigger_1',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('router prompt', () => {
  it('marks a direct iMessage ticket so the Router answers conversationally', () => {
    const message = '下午好呀，今天有什么计划吗？帮我看看窗边那本书提到的那个问题'
    const prompt = routerPromptFor(ticket({
      title: message.slice(0, 80),
      brief: message,
      threadKeys: ['imessage:chat:any;-;+1'],
      channels: [{ source: 'imessage', thread: 'chat:any;-;+1', address: { handle: '+1' } }],
    }))
    expect(prompt).toContain('direct-chat=true')
    expect(prompt).toContain(`message=${message}`)
    expect(prompt).toContain('tone=warm, playful, cute')
    expect(prompt).toContain('Follow their latest style instruction')
    expect(systemPrompt('router')).toContain('direct-chat=true')
    expect(systemPrompt('router')).toContain('reply_user')
    expect(systemPrompt('router')).toContain('do not tell the other party to stop replying')
    expect(systemPrompt('router')).toContain('Keep the conversation going')
    expect(systemPrompt('router')).toContain('Be proactive')
    expect(systemPrompt('router')).toContain('their preference wins')
    expect(systemPrompt('router')).toContain('short quote')
  })

  it('does not mark a GitHub issue as a direct chat', () => {
    const prompt = routerPromptFor(ticket())
    expect(prompt).not.toContain('direct-chat=true')
    expect(prompt).not.toContain('message=')
  })

  it('does not mark a group chat as a direct conversation', () => {
    const group = ticket({
      threadKeys: ['imessage:group:g1'],
      channels: [{
        source: 'imessage',
        thread: 'group:g1',
        address: { provider: 'imessage', group: 'g1' },
      }],
    })
    expect(routerPromptFor(group)).not.toContain('direct-chat=true')
    expect(directChatRouterShard(group)).toBeUndefined()
    expect(directChatThread(group)).toBeUndefined()
  })

  it('does not treat a group thread without a chat address as direct', () => {
    const unknownGroup = ticket({
      threadKeys: ['imessage:group-rowid:9'],
      channels: [{
        source: 'imessage',
        thread: 'group-rowid:9',
        address: { provider: 'imessage' },
      }],
    })
    expect(directChatThread(unknownGroup)).toBeUndefined()
    expect(routerPromptFor(unknownGroup)).not.toContain('direct-chat=true')
  })

  it('keeps one Router session per direct iMessage thread', () => {
    const shard = directChatRouterShard(ticket({
      threadKeys: ['imessage:chat:any;-;+1'],
      channels: [{ source: 'imessage', thread: 'chat:any;-;+1', address: { handle: '+1' } }],
    }))
    expect(shard).toBe('thread:chat:any;-;+1')
    expect(routerSessionId(shard!)).toBe('router:thread:chat:any;-;+1')
    expect(directChatRouterShard(ticket())).toBeUndefined()
  })

  it('does not recall memory across different direct iMessage threads', () => {
    const instinct = ticket({
      threadKeys: ['imessage:chat:any;-;+1'],
      channels: [{ source: 'imessage', thread: 'chat:any;-;+1', address: { handle: '+1' } }],
    })
    const chen = ticket({
      threadKeys: ['imessage:chat:any;-;+2'],
      channels: [{ source: 'imessage', thread: 'chat:any;-;+2', address: { handle: '+2' } }],
    })
    expect(sharesDirectChatThread(instinct, 'chat:any;-;+1')).toBe(true)
    expect(sharesDirectChatThread(chen, 'chat:any;-;+1')).toBe(false)
    expect(sharesDirectChatThread(chen, 'chat:any;-;+2')).toBe(true)
  })

  it('lets the thread Router session own reply_user and assess_trigger', () => {
    const direct = ticket({
      threadKeys: ['imessage:chat:any;-;+1'],
      channels: [{ source: 'imessage', thread: 'chat:any;-;+1', address: { handle: '+1' } }],
    })
    expect(routerOwnerShard(direct, 'default')).toBe('thread:chat:any;-;+1')
    expect(routerOwnerShard(ticket(), 'deploy')).toBe('deploy')
  })
})

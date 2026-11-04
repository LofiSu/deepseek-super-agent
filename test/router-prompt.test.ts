import { describe, expect, it } from 'vitest'
import { routerPromptFor } from '../src/harness/loop.ts'
import { directChatRouterShard, routerSessionId, sharesDirectChatThread } from '../src/harness/session.ts'
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
    const prompt = routerPromptFor(ticket({
      threadKeys: ['imessage:chat:any;-;+1'],
      channels: [{ source: 'imessage', thread: 'chat:any;-;+1', address: { handle: '+1' } }],
    }))
    expect(prompt).toContain('direct-chat=true')
    expect(prompt).toContain('tone=warm, playful, cute')
    expect(prompt).toContain('😺')
    expect(systemPrompt('router')).toContain('direct-chat=true')
    expect(systemPrompt('router')).toContain('reply_user')
    expect(systemPrompt('router')).toContain('do not tell the other party to stop replying')
    expect(systemPrompt('router')).toContain('Keep the conversation going')
    expect(systemPrompt('router')).toContain('Be proactive')
    expect(systemPrompt('router')).toContain('😺')
  })

  it('does not mark a GitHub issue as a direct chat', () => {
    expect(routerPromptFor(ticket())).not.toContain('direct-chat=true')
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
})

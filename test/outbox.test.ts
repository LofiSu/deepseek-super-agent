import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Outbox, PermanentDeliveryError, type OutboundAdapter } from '../src/channels/outbox-adapter.ts'
import { Replies, splitChatText } from '../src/core/replies.ts'
import type { Host } from '../src/core/host.ts'
import type { OutboxRow, Ticket } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'

const homes: string[] = []

function tempStore(): Store {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-outbox-'))
  homes.push(home)
  return new Store(home)
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'ticket_1',
    title: 'real issue',
    brief: 'real issue',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-v1',
      scope: 'real issue',
      actor: { source: 'github', id: 'LofiSu' },
      basis: 'addressed',
    },
    threadKeys: ['github:issue:7'],
    channels: [{ source: 'github', thread: 'issue:7', address: { provider: 'github', repo: 'LofiSu/x', issue: '7' } }],
    inputs: [],
    assignments: [{ id: 'asg_1', state: 'running', speculative: false }],
    speculative: false,
    originTriggerId: 'gh_issue_1_body',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 'outbox_1',
    replyId: 'reply_1',
    ticketId: 'ticket_1',
    channel: 'github',
    thread: 'issue:7',
    target: { provider: 'github', repo: 'LofiSu/x', issue: '7' },
    text: 'ds-agent note',
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('durable outbox', () => {
  it('Replies enqueues instead of claiming delivery', () => {
    const store = tempStore()
    const host: Host = {
      repo: store,
      now: () => new Date().toISOString(),
      log: () => undefined,
      metrics: { increment: () => undefined } as unknown as Host['metrics'],
      scope: { admit: () => ({ listened: true, reason: 'test' }) },
    }
    const replies = new Replies(host)
    replies.acknowledge(ticket())
    expect(store.listReplies()).toHaveLength(1)
    expect(store.listReplies()[0]!.status).toBe('pending')
    const queued = store.listOutbox('pending')
    expect(queued).toHaveLength(1)
    expect(queued[0]!.channel).toBe('github')
    expect(queued[0]!.thread).toBe('issue:7')
    expect(queued[0]!.target.issue).toBe('7')
    expect(queued[0]!.text).toContain('ds-agent note')
    store.close()
  })

  it('does not send the canned acknowledgement into an iMessage conversation', () => {
    const store = tempStore()
    const lines: string[] = []
    const host: Host = {
      repo: store,
      now: () => new Date().toISOString(),
      log: line => { lines.push(line) },
      metrics: { increment: () => undefined } as unknown as Host['metrics'],
      scope: { admit: () => ({ listened: true, reason: 'test' }) },
    }
    const imessageTicket = ticket({
      threadKeys: ['imessage:chat:any;-;+1'],
      channels: [{
        source: 'imessage',
        thread: 'chat:any;-;+1',
        address: { handle: '+1', chatGuid: 'any;-;+1' },
      }],
    })
    const replies = new Replies(host)
    replies.acknowledge(imessageTicket, 'imessage:chat:any;-;+1')
    expect(store.listReplies()).toHaveLength(0)
    expect(store.listOutbox('pending')).toHaveLength(0)
    expect(lines.some(line => line.includes('ack-suppressed') && line.includes('channel=imessage'))).toBe(true)

    // Only the acknowledgement is suppressed; the real answer still goes out.
    replies.answer(imessageTicket, '你好，我在。')
    expect(store.listReplies()).toHaveLength(1)
    expect(store.listOutbox('pending')).toHaveLength(1)
    store.close()
  })

  it('sends a direct chat answer as a few short bubbles', () => {
    const store = tempStore()
    const host: Host = {
      repo: store,
      now: () => new Date().toISOString(),
      log: () => undefined,
      metrics: { increment: () => undefined } as unknown as Host['metrics'],
      scope: { admit: () => ({ listened: true, reason: 'test' }) },
    }
    const imessageTicket = ticket({
      threadKeys: ['imessage:chat:any;-;+1'],
      channels: [{
        source: 'imessage',
        thread: 'chat:any;-;+1',
        address: { handle: '+1', chatGuid: 'any;-;+1' },
      }],
    })
    new Replies(host).answer(imessageTicket, '第一段。\n\n第二段，稍微长一点。\n\n第三段。\n\n第四段。')
    const queued = store.listOutbox('pending')
    expect(queued).toHaveLength(3)
    expect(queued[2]!.text).toContain('第三段')
    expect(queued[2]!.text).toContain('第四段')
    store.close()
  })

  it('keeps a group chat answer in one bubble', () => {
    const store = tempStore()
    const host: Host = {
      repo: store,
      now: () => new Date().toISOString(),
      log: () => undefined,
      metrics: { increment: () => undefined } as unknown as Host['metrics'],
      scope: { admit: () => ({ listened: true, reason: 'test' }) },
    }
    const groupTicket = ticket({
      threadKeys: ['imessage:group:g1'],
      channels: [{
        source: 'imessage',
        thread: 'group:g1',
        address: { provider: 'imessage', group: 'g1' },
      }],
    })
    new Replies(host).answer(groupTicket, '第一段。\n\n第二段。')
    expect(store.listOutbox('pending')).toHaveLength(1)
    store.close()
  })

  it('splits only on boundaries and never drops text', () => {
    const parts = splitChatText('一二三四五六七八九十。'.repeat(40) + '\n\n尾巴。')
    expect(parts.length).toBe(3)
    expect(parts.join('')).toContain('尾巴。')
    expect(splitChatText('一句话。')).toEqual(['一句话。'])
  })

  it('flushes through the matching adapter and records the provider id', async () => {
    const store = tempStore()
    store.addReply({
      id: 'reply_1',
      ticketId: 'ticket_1',
      channel: 'github',
      purpose: 'acknowledgement',
      text: 'ds-agent note',
      status: 'pending',
      createdAt: new Date().toISOString(),
    })
    store.enqueueOutbox(row())

    const sent: OutboxRow[] = []
    const adapter: OutboundAdapter = {
      channel: 'github',
      send: async outboxRow => {
        sent.push(outboxRow)
        return { externalId: '4242' }
      },
    }
    const outbox = new Outbox(store, [adapter])
    const result = await outbox.flush()
    expect(result).toEqual({ sent: 1, failed: 0, pending: 0 })
    expect(sent.map(item => item.id)).toEqual(['outbox_1'])
    const after = store.listOutbox()[0]!
    expect(after.status).toBe('sent')
    expect(after.externalId).toBe('4242')
    expect(after.sentAt).toBeTruthy()
    expect(store.listReplies()[0]!.status).toBe('sent')
    store.close()
  })

  it('marks an unconfigured channel failed and a CLI row local-sent', async () => {
    const store = tempStore()
    store.enqueueOutbox(row({ id: 'outbox_gh', replyId: 'reply_gh', channel: 'github' }))
    store.enqueueOutbox(row({ id: 'outbox_cli', replyId: 'reply_cli', channel: 'cli', target: {} }))
    const outbox = new Outbox(store, [])
    const result = await outbox.flush()
    expect(result.failed).toBe(1)
    expect(result.sent).toBe(1)
    const rows = store.listOutbox()
    expect(rows.find(item => item.id === 'outbox_gh')!.status).toBe('failed')
    expect(rows.find(item => item.id === 'outbox_gh')!.error).toMatch(/no outbound adapter/)
    expect(rows.find(item => item.id === 'outbox_cli')!.status).toBe('sent')
    store.close()
  })

  it('fails an unroutable row on the first flush without scheduling a retry', async () => {
    const store = tempStore()
    store.addReply({
      id: 'reply_1',
      ticketId: 'ticket_1',
      channel: 'github',
      purpose: 'acknowledgement',
      text: 'ds-agent note',
      status: 'pending',
      createdAt: new Date().toISOString(),
    })
    store.enqueueOutbox(row())

    let calls = 0
    const adapter: OutboundAdapter = {
      channel: 'github',
      send: async () => {
        calls += 1
        throw new PermanentDeliveryError('targets group without a chatGuid')
      },
    }
    const outbox = new Outbox(store, [adapter])
    const result = await outbox.flush()
    expect(result).toEqual({ sent: 0, failed: 1, pending: 0 })
    expect(calls).toBe(1)

    const after = store.listOutbox()[0]!
    expect(after.status).toBe('failed')
    expect(after.error).toBe('targets group without a chatGuid')
    // A permanent failure is terminal on the first attempt: no retry counter,
    // no backoff deadline, and the reply is not marked sent.
    expect(after.attempts ?? 0).toBe(0)
    expect(after.nextAttemptAt).toBeUndefined()
    expect(store.listReplies()[0]!.status).toBe('pending')

    await outbox.flush()
    expect(calls).toBe(1)
    expect(store.listOutbox()[0]!.status).toBe('failed')
    store.close()
  })

  it('retries a transient send failure with backoff instead of failing early', async () => {
    const store = tempStore()
    store.enqueueOutbox(row())

    let calls = 0
    const adapter: OutboundAdapter = {
      channel: 'github',
      send: async () => {
        calls += 1
        throw new Error('network down')
      },
    }
    const outbox = new Outbox(store, [adapter])
    const result = await outbox.flush()
    expect(result).toEqual({ sent: 0, failed: 0, pending: 1 })
    expect(calls).toBe(1)

    const after = store.listOutbox()[0]!
    expect(after.status).toBe('pending')
    expect(after.error).toBe('network down')
    expect(after.attempts).toBe(1)
    expect(after.nextAttemptAt).toBeTruthy()
    expect(new Date(after.nextAttemptAt!).getTime()).toBeGreaterThan(Date.now())

    // The row is not due until the backoff elapses, and it is not failed.
    await outbox.flush()
    expect(calls).toBe(1)
    expect(store.listOutbox()[0]!.status).toBe('pending')
    store.close()
  })

  it('serializes overlapping flushes so a row is sent once', async () => {
    const store = tempStore()
    store.enqueueOutbox(row())
    let calls = 0
    const adapter: OutboundAdapter = {
      channel: 'github',
      send: async () => {
        calls += 1
        await new Promise(resolve => setTimeout(resolve, 20))
        return { externalId: String(calls) }
      },
    }
    const outbox = new Outbox(store, [adapter])
    const [first, second] = await Promise.all([outbox.flush(), outbox.flush()])
    expect(calls).toBe(1)
    expect(first.sent + second.sent).toBe(1)
    store.close()
  })
})

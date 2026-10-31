import type { Outbox } from '../shared/ports.js'
import type { OutboundMessage, ReplyStatus } from '../shared/types.js'
import { AgentError } from '../shared/errors.js'
import { CliChannel } from './cli.js'
import { FakeGithubChannel } from './github.js'
import { FakeImChannel } from './im.js'
import { assertReply } from './norm.js'

export interface ChannelAdapter {
  readonly kind: string
  deliver(message: OutboundMessage): void
}

interface Queued {
  message: OutboundMessage
  status: ReplyStatus
}

/** Idempotent outbox. The first send wins. Withdraw drops a message that has not been flushed. */
export class MemoryOutbox implements Outbox {
  private readonly items = new Map<string, Queued>()

  constructor(private readonly adapters: ChannelAdapter[]) {}

  send(message: OutboundMessage): void {
    assertReply(message)
    if (this.items.has(message.id)) return
    this.adapterFor(message)
    this.items.set(message.id, { message, status: 'pending' })
  }

  status(id: string): ReplyStatus | undefined {
    return this.items.get(id)?.status
  }

  withdraw(id: string): void {
    const item = this.items.get(id)
    if (!item || item.status !== 'pending') return
    item.status = 'dropped'
  }

  /** Deliver every pending message. Dropped and sent rows stay put. */
  flush(): void {
    for (const item of this.items.values()) {
      if (item.status !== 'pending') continue
      this.adapterFor(item.message).deliver(item.message)
      item.status = 'sent'
    }
  }

  private adapterFor(message: OutboundMessage): ChannelAdapter {
    const adapter = this.adapters.find(item => item.kind === message.channel.source)
    if (!adapter) throw new AgentError('channel_missing', `no adapter for ${message.channel.source}`)
    return adapter
  }
}

export function defaultAdapters(): ChannelAdapter[] {
  return [new CliChannel(), new FakeImChannel(), new FakeGithubChannel()]
}

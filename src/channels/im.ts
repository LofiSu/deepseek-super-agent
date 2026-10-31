import type { OutboundMessage, ReplyKind } from '../shared/types.js'
import { assertReply, formatReply, type NormalizedInbound } from './norm.js'

export interface ImLine {
  from: string
  text: string
  kind?: ReplyKind
}

/** In-memory chat rooms. Not a Feishu client. */
export class FakeImChannel {
  readonly kind = 'im' as const
  readonly rooms = new Map<string, ImLine[]>()

  deliver(message: OutboundMessage): void {
    assertReply(message)
    const room = message.channel.address.room ?? message.channel.thread
    const lines = this.rooms.get(room) ?? []
    lines.push({ from: 'ds-agent', text: formatReply(message), kind: message.kind })
    this.rooms.set(room, lines)
  }

  post(room: string, from: string, text: string, at = new Date().toISOString()): NormalizedInbound {
    const lines = this.rooms.get(room) ?? []
    lines.push({ from, text })
    this.rooms.set(room, lines)
    return {
      source: this.kind,
      threadId: room,
      actorId: from,
      human: !from.endsWith('-bot'),
      text,
      at,
      address: { room },
    }
  }
}

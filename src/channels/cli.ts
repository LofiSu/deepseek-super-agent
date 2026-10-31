import type { OutboundMessage } from '../shared/types.js'
import { assertReply, formatReply, type NormalizedInbound } from './norm.js'

/** Local CLI transcript. Inbound lines are pushed by the caller; nothing reads a real terminal. */
export class CliChannel {
  readonly kind = 'cli' as const
  readonly outbound: string[] = []

  deliver(message: OutboundMessage): void {
    assertReply(message)
    this.outbound.push(formatReply(message))
  }

  receive(text: string, actorId = 'local', at = new Date().toISOString()): NormalizedInbound {
    return {
      source: this.kind,
      threadId: 'cli',
      actorId,
      human: true,
      text,
      at,
      address: { stream: 'stdout' },
    }
  }
}

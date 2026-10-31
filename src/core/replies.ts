import { AgentError } from '../shared/errors.js'
import type { OutboundMessage, ReplyKind, Ticket } from '../shared/types.js'
import type { EngineHost } from './ports.js'

/** Queue a Channel write. The outbox runs after the transaction commits. */
export function queueReply(host: EngineHost, ticket: Ticket, kind: ReplyKind, text: string, required = false): void {
  const channel = ticket.channels[0]
  if (!channel) {
    if (required) throw new AgentError('channel_missing', `ticket ${ticket.id} has no channel`)
    return
  }
  const message: OutboundMessage = {
    id: `${kind}-${ticket.id}-${host.id('reply')}`,
    channel,
    text,
    kind,
    ticketId: ticket.id,
  }
  host.effects.push(() => host.outbox.send(message))
}

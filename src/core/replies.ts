import { renderOutbound } from '../channels/norms.ts'
import { maySurface } from '../speculate/gate.ts'
import type { Ticket } from '../shared/types.ts'
import type { Host } from './host.ts'

export class Replies {
  constructor(private readonly host: Host) {}

  acknowledge(ticket: Ticket): void {
    this.send(ticket, `Acknowledged “${ticket.title}”. Working on it.`, 'acknowledgement')
  }

  answer(ticket: Ticket, text: string): void {
    this.send(ticket, text, 'result')
  }

  send(ticket: Ticket, text: string, purpose: string): void {
    if (!maySurface(ticket.speculative, ticket.speculative ? false : undefined)) {
      this.host.log(`[speculate] reply held ticketId=${ticket.id} purpose=${purpose}`)
      return
    }
    const ref = ticket.channels[0]
    const channel = ref?.source ?? 'cli'
    const thread = ref?.thread ?? 'local'
    const target = ref?.address ?? {}
    const rendered = renderOutbound(channel, text, ticket.id)
    const createdAt = this.host.now()
    const row = {
      id: this.host.repo.nextId('reply'),
      ticketId: ticket.id,
      channel,
      purpose,
      text: rendered,
      status: 'pending' as const,
      createdAt,
    }
    this.host.repo.addReply(row)
    // The CLI channel is local stdout; there is no remote hop to wait for.
    if (channel === 'cli') {
      this.host.repo.markReplySent(row.id)
      this.host.log(`[channel] norm=${channel} ticketId=${ticket.id} purpose=${purpose} local-sent`)
      this.host.log(`[reply] purpose=${purpose} ticketId=${ticket.id} channel=${channel} thread=${thread} text=${rendered.replace(/\s+/g, ' ')}`)
      return
    }
    // Remote outbound goes through the durable outbox. A channel adapter
    // (Feishu/GitHub) marks the row sent only after the real API accepts it.
    const outboxId = this.host.repo.nextId('outbox')
    this.host.repo.enqueueOutbox({
      id: outboxId,
      replyId: row.id,
      ticketId: ticket.id,
      channel,
      thread,
      target,
      text: rendered,
      status: 'pending',
      createdAt,
    })
    this.host.log(`[channel] norm=${channel} ticketId=${ticket.id} purpose=${purpose}`)
    this.host.log(`[reply] purpose=${purpose} ticketId=${ticket.id} channel=${channel} thread=${thread} text=${rendered.replace(/\s+/g, ' ')}`)
    this.host.log(`[outbox] enqueue outboxId=${outboxId} replyId=${row.id} channel=${channel} thread=${thread} ticketId=${ticket.id}`)
  }
}

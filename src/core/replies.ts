import { renderOutbound } from '../channels/norms.ts'
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
    const channel = ticket.channels[0]?.source ?? 'cli'
    const rendered = renderOutbound(channel, text, ticket.id)
    const row = {
      id: this.host.repo.nextId('reply'),
      ticketId: ticket.id,
      channel,
      purpose,
      text: rendered,
      status: 'sent' as const,
      createdAt: this.host.now(),
    }
    this.host.repo.addReply(row)
    this.host.log(`[channel] norm=${channel} ticketId=${ticket.id} purpose=${purpose}`)
    this.host.log(`[reply] purpose=${purpose} ticketId=${ticket.id} channel=${channel} text=${rendered.replace(/\s+/g, ' ')}`)
  }
}

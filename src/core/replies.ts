import { renderOutbound } from '../channels/norms.ts'
import { OUTBOX_RETRY_BASE_KEY, PROACTIVE_RETRY_BASE_MS } from '../channels/outbox-adapter.ts'
import { maySurface } from '../speculate/gate.ts'
import type { Ticket } from '../shared/types.ts'
import type { Host } from './host.ts'

export class Replies {
  constructor(private readonly host: Host) {}

  acknowledge(ticket: Ticket, threadKey?: string): void {
    // A proactive idle wake is already a message. A canned "Acknowledged"
    // before the Router decides would be exactly the noise this feature must
    // not send, so the Router's one turn is the only possible output.
    if (ticket.channels.some(channel => channel.address?.proactive === '1')) {
      this.host.log(`[reply] ack-suppressed ticketId=${ticket.id} channel=proactive reason=conversational`)
      return
    }
    // iMessage is a live conversation: a canned English acknowledgement before
    // the Router has even decided whether there is work is noise, and it cannot
    // be retracted when the Router vetoes (the sender sees "Working on it."
    // followed by silence). Only the real result goes back to a chat.
    if (channelFor(ticket, threadKey)?.source === 'imessage') {
      this.host.log(`[reply] ack-suppressed ticketId=${ticket.id} channel=imessage reason=conversational`)
      return
    }
    this.send(ticket, `Acknowledged “${ticket.title}”. Working on it.`, 'acknowledgement', threadKey)
  }

  answer(ticket: Ticket, text: string): void {
    this.send(ticket, text, 'result')
  }

  send(ticket: Ticket, text: string, purpose: string, threadKey?: string): void {
    if (!maySurface(ticket.speculative, ticket.speculative ? false : undefined)) {
      this.host.log(`[speculate] reply held ticketId=${ticket.id} purpose=${purpose}`)
      return
    }
    const ref = channelFor(ticket, threadKey)
    const channel = ref?.source ?? 'cli'
    const thread = ref?.thread ?? 'local'
    // A proactive idle message is not urgent: a transient send failure must
    // wait minutes, not seconds. This reserved target key is consumed by the
    // Outbox and ignored by the channel adapters.
    const proactive = ticket.channels.some(item => item.address?.proactive === '1')
    const target: Record<string, string> = {
      ...(ref?.address ?? {}),
      ...(proactive ? { [OUTBOX_RETRY_BASE_KEY]: String(PROACTIVE_RETRY_BASE_MS) } : {}),
    }
    const rendered = renderOutbound(channel, text, ticket.id)
    // A direct chat reads like texting: one long block feels like a letter.
    // Split at paragraph/sentence boundaries into at most three bubbles.
    const directChat = channel === 'imessage' && target.group == null
    const parts = directChat ? splitChatText(rendered) : [rendered]
    for (const [index, part] of parts.entries()) {
      const label = parts.length > 1 ? `${purpose} part=${index + 1}/${parts.length}` : purpose
      const createdAt = this.host.now()
      const row = {
        id: this.host.repo.nextId('reply'),
        ticketId: ticket.id,
        channel,
        purpose: label,
        text: part,
        status: 'pending' as const,
        createdAt,
      }
      this.host.repo.addReply(row)
      // The CLI channel is local stdout; there is no remote hop to wait for.
      if (channel === 'cli') {
        this.host.repo.markReplySent(row.id)
        this.host.log(`[channel] norm=${channel} ticketId=${ticket.id} purpose=${label} local-sent`)
        this.host.log(`[reply] purpose=${label} ticketId=${ticket.id} channel=${channel} thread=${thread} text=${part.replace(/\s+/g, ' ')}`)
        continue
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
        text: part,
        status: 'pending',
        idempotencyKey: row.id,
        attempts: 0,
        createdAt,
      })
      this.host.log(`[channel] norm=${channel} ticketId=${ticket.id} purpose=${label}`)
      this.host.log(`[reply] purpose=${label} ticketId=${ticket.id} channel=${channel} thread=${thread} text=${part.replace(/\s+/g, ' ')}`)
      this.host.log(`[outbox] enqueue outboxId=${outboxId} replyId=${row.id} channel=${channel} thread=${thread} ticketId=${ticket.id}`)
    }
  }
}

/** Bubbles per reply, not messages per turn: enough to feel like texting. */
export const MAX_CHAT_PARTS = 3
const CHAT_PART_CHARS = 280

/**
 * Split a conversational reply into texting-sized bubbles: paragraphs first,
 * then long paragraphs at sentence boundaries. At most `maxParts` bubbles;
 * the tail is merged into the last one so no content is dropped.
 */
export function splitChatText(text: string, maxParts = MAX_CHAT_PARTS): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const parts: string[] = []
  for (const paragraph of trimmed.split(/\n{2,}/).map(value => value.trim()).filter(Boolean)) {
    if (paragraph.length <= CHAT_PART_CHARS) {
      parts.push(paragraph)
      continue
    }
    let chunk = ''
    // Split after the punctuation but keep the whitespace: consuming it would
    // glue English sentences together ("Hello.World") inside one bubble.
    for (const sentence of paragraph.split(/(?<=[。！？.!?；;]\s*)(?=\S)/u).filter(Boolean)) {
      if (chunk && chunk.length + sentence.length > CHAT_PART_CHARS) {
        parts.push(chunk.trim())
        chunk = ''
      }
      chunk += sentence
    }
    if (chunk.trim()) parts.push(chunk.trim())
  }
  if (parts.length <= maxParts) return parts
  const head = parts.slice(0, maxParts - 1)
  head.push(parts.slice(maxParts - 1).join('\n\n'))
  return head
}

/**
 * A reply belongs to the Thread that produced the input, not to whichever
 * Channel happened to be first on the Ticket. `threadKey` is `source:id`.
 */
function channelFor(ticket: Ticket, threadKey?: string): Ticket['channels'][number] | undefined {
  if (!threadKey) return ticket.channels[0]
  const split = threadKey.indexOf(':')
  const source = split < 0 ? undefined : threadKey.slice(0, split)
  const id = split < 0 ? threadKey : threadKey.slice(split + 1)
  return ticket.channels.find(ref => ref.thread === id && (source == null || ref.source === source))
    ?? ticket.channels[0]
}

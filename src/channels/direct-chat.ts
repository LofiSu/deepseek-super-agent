import type { Ticket } from '../shared/types.ts'

export type ChannelRef = Ticket['channels'][number]

/** A 1:1 chat thread (iMessage DM, Feishu p2p direct). Not a group/topic mandate thread. */
export function directConversationalChannel(ref: ChannelRef | undefined): boolean {
  if (!ref) return false
  if (ref.source === 'imessage' && ref.address?.group == null) return true
  if (ref.source === 'im' && ref.address?.provider === 'feishu' && ref.address?.group == null) return true
  return false
}

export function ticketIsDirectConversation(ticket: Ticket): boolean {
  return ticket.channels.some(directConversationalChannel)
}

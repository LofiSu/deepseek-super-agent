import { AgentError } from '../shared/errors.js'
import type { OutboundMessage, ReplyKind } from '../shared/types.js'

export const REPLY_KINDS = ['acknowledgement', 'answer', 'result', 'attention'] as const satisfies readonly ReplyKind[]

export interface NormalizedInbound {
  source: string
  threadId: string
  actorId: string
  human: boolean
  text: string
  at: string
  address: Record<string, string>
}

export function assertReply(message: OutboundMessage): void {
  if (!REPLY_KINDS.includes(message.kind)) {
    throw new AgentError('reply_kind', `unknown reply kind ${message.kind}`)
  }
  if (!message.id || !message.text) throw new AgentError('reply_shape', 'reply needs id and text')
}

/** One line per outbound reply. Adapters share this shape. */
export function formatReply(message: OutboundMessage): string {
  assertReply(message)
  const ticket = message.ticketId ? ` ticket=${message.ticketId}` : ''
  return `${message.kind}${ticket}: ${message.text}`
}

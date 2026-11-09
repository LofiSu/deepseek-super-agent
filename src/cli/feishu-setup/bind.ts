import crypto from 'node:crypto'

/**
 * Feishu p2p bind: accept only a human sender in a p2p chat who sends the exact
 * one-time passphrase. Used by `ds-agent feishu setup` (long-connection listener).
 */

export type FeishuBindVerdict =
  | 'accept'
  | 'reject-not-p2p'
  | 'reject-bot'
  | 'reject-passphrase'
  | 'reject-no-sender'
  | 'ignore'

export interface FeishuBindMessageView {
  chatId?: string
  chatType?: string
  senderOpenId?: string
  senderType?: string
  text: string
}

export function flattenFeishuEventText(content: unknown, msgType?: string): string {
  if (typeof content !== 'string' || !content.trim()) return ''
  if (msgType === 'text' || content.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(content) as { text?: string }
      if (typeof parsed.text === 'string') return parsed.text.trim()
    } catch {
      /* fall through */
    }
  }
  return content.trim()
}

/** Map an `im.message.receive_v1`-style event body to a bind view (SDK or REST shape). */
export function feishuBindMessageFromEvent(payload: unknown): FeishuBindMessageView | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const record = payload as Record<string, unknown>
  const event = (record.event ?? record) as Record<string, unknown> | undefined
  if (!event || typeof event !== 'object') return undefined
  const message = event.message as Record<string, unknown> | undefined
  if (!message || typeof message !== 'object') return undefined
  const sender = event.sender as Record<string, unknown> | undefined
  const senderId = sender?.sender_id as Record<string, unknown> | undefined
  const openId = senderId?.open_id ?? senderId?.user_id ?? senderId?.union_id
  const msgType = typeof message.msg_type === 'string' ? message.msg_type : undefined
  const rawContent = message.content ?? (message.body as { content?: unknown } | undefined)?.content
  const text = flattenFeishuEventText(rawContent, msgType)
  return {
    chatId: typeof message.chat_id === 'string' ? message.chat_id : undefined,
    chatType: typeof message.chat_type === 'string' ? message.chat_type : undefined,
    senderOpenId: typeof openId === 'string' ? openId : undefined,
    senderType: typeof sender?.sender_type === 'string' ? sender.sender_type : undefined,
    text,
  }
}

export function evaluateFeishuBind(
  view: FeishuBindMessageView,
  passphrase: string,
  botOpenId?: string,
): FeishuBindVerdict {
  const senderType = view.senderType?.toLowerCase()
  if (senderType === 'app' || senderType === 'bot') return 'reject-bot'
  if (botOpenId && view.senderOpenId === botOpenId) return 'reject-bot'
  if (view.chatType && view.chatType !== 'p2p') return 'reject-not-p2p'
  if (!view.senderOpenId) return 'reject-no-sender'
  const expected = passphrase.trim()
  if (!view.text) return 'ignore'
  if (view.text.trim() !== expected) return 'reject-passphrase'
  if (!view.chatId) return 'reject-no-sender'
  return 'accept'
}

export function generateBindPassphrase(byteLength = 12): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.randomBytes(byteLength)
  let out = ''
  for (const byte of bytes) out += alphabet[byte % alphabet.length]!
  return `BIND-${out}`
}

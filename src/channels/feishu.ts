import crypto from 'node:crypto'
import type { OutboxRow, Trigger } from '../shared/types.ts'
import type { OutboundAdapter } from './outbox-adapter.ts'

/**
 * Production Feishu/Lark IM channel.
 *
 * Inbound: event-webhook parser (`im.message.receive_v1`, plaintext or
 * AES-256-CBC encrypted) plus a polling Source over the message-list API.
 * Outbound: real message API (`/im/v1/messages` or `/im/v1/messages/:id/reply`).
 *
 * Required env for a live run:
 *   FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_CHAT_ID
 * Optional:
 *   FEISHU_BASE_URL (default https://open.feishu.cn; use https://open.larksuite.com)
 *   FEISHU_VERIFICATION_TOKEN, FEISHU_ENCRYPT_KEY, FEISHU_BOT_OPEN_ID
 *
 * Bot permissions: im:message, im:message.send_as_bot, im:message:readonly (or
 * the corresponding granular scopes). The bot must be a member of the chat.
 */

export interface FeishuConfig {
  appId: string
  appSecret: string
  baseUrl: string
  chatId?: string
  verificationToken?: string
  encryptKey?: string
  botOpenId?: string
}

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

/** `null` when Feishu is not configured; throws on a half-set app credential. */
export function feishuConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FeishuConfig | null {
  const appId = read(env, 'FEISHU_APP_ID')
  const appSecret = read(env, 'FEISHU_APP_SECRET')
  if (!appId && !appSecret) return null
  if (!appId || !appSecret) {
    throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be set together; refusing a half-configured Feishu channel.')
  }
  return {
    appId,
    appSecret,
    baseUrl: (read(env, 'FEISHU_BASE_URL') ?? 'https://open.feishu.cn').replace(/\/$/, ''),
    chatId: read(env, 'FEISHU_CHAT_ID'),
    verificationToken: read(env, 'FEISHU_VERIFICATION_TOKEN'),
    encryptKey: read(env, 'FEISHU_ENCRYPT_KEY'),
    botOpenId: read(env, 'FEISHU_BOT_OPEN_ID'),
  }
}

export interface FeishuSender {
  id?: string
  id_type?: string
  sender_type?: string
  tenant_key?: string
}

export interface FeishuMention {
  key?: string
  name?: string
  id?: { open_id?: string; user_id?: string; union_id?: string }
}

/** Shape of one item from `/open-apis/im/v1/messages` (and the webhook event.message). */
export interface FeishuMessage {
  message_id: string
  chat_id: string
  msg_type: string
  body?: { content?: string }
  content?: string
  create_time: string
  update_time?: string
  thread_id?: string
  root_id?: string
  parent_id?: string
  sender?: FeishuSender
  mentions?: FeishuMention[]
  deleted?: boolean
}

export interface FeishuListOptions {
  startTimeSec?: number
  endTimeSec?: number
  pageSize?: number
  threadId?: string
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class FeishuApiError extends Error {
  constructor(readonly code: number, message: string, readonly path: string) {
    super(`Feishu ${path} failed code=${code}: ${message}`)
    this.name = 'FeishuApiError'
  }
}

/** Minimal real Feishu Open Platform client with a cached tenant access token. */
export class FeishuClient {
  private token?: { value: string; expiresAt: number }

  constructor(
    private readonly config: FeishuConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value
    const response = await this.fetchImpl(`${this.config.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
    })
    const json = await response.json() as {
      code?: number
      msg?: string
      tenant_access_token?: string
      expire?: number
    }
    if (!response.ok || json.code !== 0 || !json.tenant_access_token) {
      throw new FeishuApiError(json.code ?? response.status, json.msg ?? 'no tenant_access_token', 'auth/v3/tenant_access_token')
    }
    const ttlMs = Math.max(60, Number(json.expire ?? 3600) - 60) * 1000
    this.token = { value: json.tenant_access_token, expiresAt: Date.now() + ttlMs }
    return this.token.value
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {}): Promise<T> {
    const token = await this.accessToken()
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) params.set(key, String(value))
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : ''
    const response = await this.fetchImpl(`${this.config.baseUrl}${path}${suffix}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const json = await response.json() as { code?: number; msg?: string; data?: T }
    if (!response.ok || json.code !== 0) {
      throw new FeishuApiError(json.code ?? response.status, json.msg ?? 'request failed', path)
    }
    return (json.data ?? {}) as T
  }

  /** All messages in a chat since `startTimeSec`, oldest first, page-limited. */
  async listMessages(chatId: string, options: FeishuListOptions = {}): Promise<FeishuMessage[]> {
    const items: FeishuMessage[] = []
    let pageToken: string | undefined
    for (let page = 0; page < 20; page += 1) {
      const data = await this.request<{
        items?: FeishuMessage[]
        has_more?: boolean
        page_token?: string
      }>('/open-apis/im/v1/messages', {
        query: {
          container_id_type: 'chat',
          container_id: chatId,
          start_time: options.startTimeSec,
          end_time: options.endTimeSec,
          sort_type: 'ByCreateTimeAsc',
          page_size: options.pageSize ?? 50,
          page_token: pageToken,
        },
      })
      for (const item of data.items ?? []) items.push(item)
      if (!data.has_more || !data.page_token) break
      pageToken = data.page_token
    }
    return items.filter(item => !item.deleted)
  }

  async sendText(chatId: string, text: string): Promise<{ message_id: string }> {
    return this.request<{ message_id: string }>('/open-apis/im/v1/messages', {
      method: 'POST',
      query: { receive_id_type: 'chat_id' },
      body: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
    })
  }

  async replyText(messageId: string, text: string): Promise<{ message_id: string }> {
    return this.request<{ message_id: string }>(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      method: 'POST',
      body: { msg_type: 'text', content: JSON.stringify({ text }) },
    })
  }

  async getMessage(messageId: string): Promise<FeishuMessage | undefined> {
    const data = await this.request<{ items?: FeishuMessage[] }>(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
    )
    return data.items?.[0]
  }
}

/** Flatten the text-bearing parts of a Feishu message (`text`, `post`, cards). */
export function flattenFeishuMessage(message: FeishuMessage): string {
  const raw = message.body?.content ?? message.content ?? ''
  if (message.msg_type === 'text') {
    try {
      const parsed = JSON.parse(raw) as { text?: string }
      return parsed.text ?? raw
    } catch {
      return raw
    }
  }
  if (message.msg_type === 'post') {
    try {
      const parsed = JSON.parse(raw) as { title?: string; content?: unknown }
      const parts: string[] = []
      if (parsed.title) parts.push(parsed.title)
      collectPostText(parsed.content, parts)
      return parts.join('\n').trim()
    } catch {
      return raw
    }
  }
  if (message.msg_type === 'image') return '[image]'
  if (message.msg_type === 'file') return '[file]'
  if (message.msg_type === 'audio') return '[audio]'
  return raw
}

function collectPostText(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    out.push(node)
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) collectPostText(item, out)
    return
  }
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>
    if (typeof record.text === 'string') out.push(record.text)
    if (typeof record.content === 'string') out.push(record.content)
    for (const value of Object.values(record)) {
      if (value !== record.text && typeof value !== 'string') collectPostText(value, out)
    }
  }
}

export function feishuThread(chatId: string, threadId?: string): string {
  return threadId ? `feishu:${chatId}:${threadId}` : `feishu:${chatId}`
}

function mentionsBot(message: FeishuMessage, config?: FeishuConfig): boolean {
  const text = flattenFeishuMessage(message)
  if (/@ds-agent\b/i.test(text)) return true
  const mentions = message.mentions ?? []
  return mentions.some(mention =>
    (config?.botOpenId != null && mention.id?.open_id === config.botOpenId)
    || /ds-agent/i.test(mention.name ?? ''))
}

export function feishuTriggerFromMessage(message: FeishuMessage, config?: FeishuConfig): Trigger {
  const text = flattenFeishuMessage(message)
  const thread = feishuThread(message.chat_id, message.thread_id)
  const addressed = mentionsBot(message, config) ? 'mention' as const : undefined
  const senderType = message.sender?.sender_type
  return {
    id: `feishu_${message.message_id}`,
    source: 'im',
    threads: [{ source: 'im', id: thread }],
    actor: { source: 'im', id: message.sender?.id ?? 'unknown' },
    human: senderType !== 'app' && senderType !== 'bot',
    addressed,
    at: new Date(Number(message.create_time)).toISOString(),
    text,
    channel: {
      source: 'im',
      thread,
      address: {
        provider: 'feishu',
        chat_id: message.chat_id,
        message_id: message.message_id,
        ...(message.thread_id ? { thread_id: message.thread_id } : {}),
      },
    },
    meta: {
      provider: 'feishu',
      chat_id: message.chat_id,
      message_id: message.message_id,
      msg_type: message.msg_type,
      sender_type: senderType ?? 'unknown',
      ...(message.thread_id ? { thread_id: message.thread_id } : {}),
      ...(message.root_id ? { root_id: message.root_id } : {}),
      ...(message.parent_id ? { parent_id: message.parent_id } : {}),
    },
  }
}

/** Polling Source over a real Feishu chat. Repeated pulls are safe (Trigger ids dedupe). */
export class FeishuSource {
  private cursorMs: number

  constructor(
    private readonly client: FeishuClient,
    private readonly chatId: string,
    options: { sinceMs?: number; threadId?: string; pageSize?: number; config?: FeishuConfig } = {},
  ) {
    this.cursorMs = options.sinceMs ?? Date.now() - 5 * 60_000
    this.threadId = options.threadId
    this.pageSize = options.pageSize
    this.config = options.config
  }

  private readonly threadId?: string
  private readonly pageSize?: number
  private readonly config?: FeishuConfig

  async pull(): Promise<Trigger[]> {
    const startTimeSec = Math.max(0, Math.floor((this.cursorMs - 1_000) / 1_000))
    const items = await this.client.listMessages(this.chatId, {
      startTimeSec,
      pageSize: this.pageSize,
    })
    const triggers: Trigger[] = []
    for (const item of items) {
      if (this.threadId && item.thread_id !== this.threadId) continue
      triggers.push(feishuTriggerFromMessage(item, this.config))
      const at = Number(item.create_time)
      if (Number.isFinite(at) && at > this.cursorMs) this.cursorMs = at
    }
    return triggers
  }
}

/** Decrypt a Feishu event envelope (AES-256-CBC, key = SHA-256(Encrypt Key)). */
export function decryptFeishuPayload(encrypted: string, encryptKey: string): string {
  if (!encryptKey) throw new Error('FEISHU_ENCRYPT_KEY is required for an encrypted Feishu payload')
  const key = crypto.createHash('sha256').update(encryptKey).digest()
  const buffer = Buffer.from(encrypted, 'base64')
  if (buffer.length <= 16) throw new Error('encrypted Feishu payload is too short')
  const iv = buffer.subarray(0, 16)
  const data = buffer.subarray(16)
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

export interface FeishuWebhookResult {
  /** Return this to Feishu for `url_verification`. */
  challenge?: string
  trigger?: Trigger
  ignored?: string
}

/**
 * Parse a Feishu event-callback body. Handles URL verification, encrypted
 * envelopes, and `im.message.receive_v1`. Verification tokens are enforced
 * when `FEISHU_VERIFICATION_TOKEN` is configured.
 */
export function parseFeishuWebhook(payload: unknown, config: FeishuConfig): FeishuWebhookResult {
  let body = payload
  if (body && typeof body === 'object' && typeof (body as { encrypt?: unknown }).encrypt === 'string') {
    body = JSON.parse(decryptFeishuPayload((body as { encrypt: string }).encrypt, config.encryptKey ?? '')) as unknown
  }
  if (!body || typeof body !== 'object') return { ignored: 'not-an-object' }
  const record = body as Record<string, unknown>

  // URL verification (v1 callback).
  if (record.type === 'url_verification') {
    if (config.verificationToken && record.token !== config.verificationToken) {
      throw new Error('Feishu url_verification token mismatch')
    }
    return { challenge: String(record.challenge ?? '') }
  }

  const header = record.header as { event_type?: string; token?: string } | undefined
  if (config.verificationToken && header?.token && header.token !== config.verificationToken) {
    throw new Error('Feishu event token mismatch')
  }
  if (header?.event_type !== 'im.message.receive_v1') {
    return { ignored: header?.event_type ?? 'unknown-event' }
  }
  const event = record.event as {
    sender?: { sender_id?: { open_id?: string; user_id?: string; union_id?: string }; sender_type?: string; tenant_key?: string }
    message?: Omit<FeishuMessage, 'chat_id' | 'sender'> & { chat_id?: string }
  } | undefined
  const message = event?.message
  if (!message?.message_id || !message.chat_id) return { ignored: 'no-message' }
  const sender = event?.sender
  const senderId = sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? sender?.sender_id?.union_id
  return {
    trigger: feishuTriggerFromMessage({
      ...message,
      chat_id: message.chat_id,
      sender: {
        id: senderId,
        sender_type: sender?.sender_type,
        tenant_key: sender?.tenant_key,
      },
    } as FeishuMessage, config),
  }
}

/** Real outbound adapter for Feishu IM. Replies in-thread when a message id is known. */
export class FeishuOutboxAdapter implements OutboundAdapter {
  readonly channel = 'im'

  constructor(
    private readonly client: FeishuClient,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  async send(row: OutboxRow): Promise<{ externalId: string }> {
    const provider = row.target.provider
    if (provider && provider !== 'feishu') {
      throw new Error(`im outbox row ${row.id} targets ${provider}, not feishu`)
    }
    const messageId = row.target.message_id
    const chatId = row.target.chat_id
    let result: { message_id: string }
    if (messageId) result = await this.client.replyText(messageId, row.text)
    else if (chatId) result = await this.client.sendText(chatId, row.text)
    else throw new Error(`feishu outbox row ${row.id} has no chat_id/message_id`)
    if (!result.message_id) throw new Error(`Feishu send returned no message_id for outbox row ${row.id}`)
    this.log(`[feishu] outbound message_id=${result.message_id} chat=${chatId ?? '-'} inReplyTo=${messageId ?? '-'}`)
    return { externalId: result.message_id }
  }
}

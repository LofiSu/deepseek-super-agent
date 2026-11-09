import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  FeishuClient,
  FeishuOutboxAdapter,
  FeishuSource,
  decryptFeishuPayload,
  feishuConfigFromEnv,
  feishuTriggerFromMessage,
  flattenFeishuMessage,
  parseFeishuWebhook,
  type FeishuConfig,
  type FeishuMessage,
} from '../src/channels/feishu.ts'
import { filterTrigger, ruleClassify } from '../src/ingress/filter.ts'
import { admissionRulesFromEnv } from '../src/runtime.ts'
import type { OutboxRow, Trigger } from '../src/shared/types.ts'

const config: FeishuConfig = {
  appId: 'cli_app',
  appSecret: 'secret',
  baseUrl: 'https://open.feishu.cn',
  chatId: 'oc_chat',
  verificationToken: 'verify-me',
  encryptKey: 'encrypt-key',
  botOpenId: 'ou_bot',
}

function message(overrides: Partial<FeishuMessage> = {}): FeishuMessage {
  return {
    message_id: 'om_1',
    chat_id: 'oc_chat',
    msg_type: 'text',
    body: { content: JSON.stringify({ text: '@ds-agent please fix the login timeout' }) },
    create_time: '1761958800000',
    sender: { id: 'ou_alice', sender_type: 'user' },
    ...overrides,
  }
}

function encrypt(plain: string, key: string): string {
  const digest = crypto.createHash('sha256').update(key).digest()
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', digest, iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, encrypted]).toString('base64')
}

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown }

function fakeFetch(handler: Handler) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init })
    const result = handler(url, init)
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { fn, calls }
}

const tokenHandler: Handler = url => url.includes('tenant_access_token')
  ? { body: { code: 0, tenant_access_token: 'tok_1', expire: 7200 } }
  : { body: { code: 999, msg: `unexpected ${url}` } }

/** Deterministic semantic layer; admission itself stays on the fast path. */
const ruleSemantic = {
  name: 'RuleSemantic',
  classify: (trigger: Trigger) => ruleClassify(trigger),
  async complete() {
    return { text: '' }
  },
}

describe('Feishu config', () => {
  it('is absent when no app credentials are set', () => {
    expect(feishuConfigFromEnv({})).toBeNull()
  })

  it('throws on a half-configured app rather than silently disabling IM', () => {
    expect(() => feishuConfigFromEnv({ FEISHU_APP_ID: 'app' })).toThrow(/set together/)
    expect(() => feishuConfigFromEnv({ FEISHU_APP_SECRET: 'secret' })).toThrow(/set together/)
  })

  it('reads optional base, chat, token, encrypt key, and bot id', () => {
    expect(feishuConfigFromEnv({
      FEISHU_APP_ID: 'app',
      FEISHU_APP_SECRET: 'secret',
      FEISHU_CHAT_ID: 'oc_1',
      FEISHU_BASE_URL: 'https://open.larksuite.com/',
      FEISHU_VERIFICATION_TOKEN: 'v',
      FEISHU_ENCRYPT_KEY: 'k',
      FEISHU_BOT_OPEN_ID: 'ou_b',
    })).toEqual({
      appId: 'app',
      appSecret: 'secret',
      baseUrl: 'https://open.larksuite.com',
      chatId: 'oc_1',
      verificationToken: 'v',
      encryptKey: 'k',
      botOpenId: 'ou_b',
    })
  })
})

describe('Feishu message mapping', () => {
  it('flattens text messages', () => {
    expect(flattenFeishuMessage(message())).toBe('@ds-agent please fix the login timeout')
  })

  it('flattens file_key JSON bodies as media placeholders, not raw JSON', () => {
    const fileShell = message({
      msg_type: 'text',
      body: { content: JSON.stringify({ file_key: 'v3_0016b_04873018-837a-470c-8e0e-1b7b0ad8b84g' }) },
    })
    expect(flattenFeishuMessage(fileShell)).toBe('[file]')
    const imageShell = message({
      msg_type: 'text',
      body: { content: JSON.stringify({ image_key: 'img_abc' }) },
    })
    expect(flattenFeishuMessage(imageShell)).toBe('[image]')
    const typedImage = message({
      msg_type: 'image',
      body: { content: JSON.stringify({ image_key: 'img_abc' }) },
    })
    expect(flattenFeishuMessage(typedImage)).toBe('[image]')
  })

  it('flattens rich post messages', () => {
    const post = message({
      msg_type: 'post',
      body: {
        content: JSON.stringify({
          title: 'Incident',
          content: [[{ tag: 'text', text: 'line one' }], [{ tag: 'text', text: 'line two' }]],
        }),
      },
    })
    expect(flattenFeishuMessage(post)).toContain('Incident')
    expect(flattenFeishuMessage(post)).toContain('line one')
    expect(flattenFeishuMessage(post)).toContain('line two')
  })

  it('maps a real chat message to an im Trigger with a Feishu target', () => {
    const trigger = feishuTriggerFromMessage(message(), config)
    expect(trigger.id).toBe('feishu_om_1')
    expect(trigger.source).toBe('im')
    expect(trigger.threads).toEqual([{ source: 'im', id: 'feishu:oc_chat' }])
    expect(trigger.actor).toEqual({ source: 'im', id: 'ou_alice' })
    expect(trigger.human).toBe(true)
    expect(trigger.addressed).toBe('mention')
    expect(trigger.channel?.address).toMatchObject({
      provider: 'feishu',
      chat_id: 'oc_chat',
      group: 'oc_chat',
      message_id: 'om_1',
    })
    expect(new Date(trigger.at).toISOString()).toBe('2025-11-01T01:00:00.000Z')
  })

  it('admits a real chat message by its chat id and denies a different group', () => {
    const trigger = feishuTriggerFromMessage(message(), config)
    expect(trigger.channel?.address?.group).toBe('oc_chat')

    // The same id a deployment puts in DS_AGENT_GROUP_ALLOWLIST admits this trigger.
    const allowed = admissionRulesFromEnv({ DS_AGENT_GROUP_ALLOWLIST: 'oc_chat' })
    expect(filterTrigger(trigger, ruleSemantic, allowed)).toMatchObject({ action: 'pass' })

    const denied = admissionRulesFromEnv({ DS_AGENT_GROUP_ALLOWLIST: 'oc_other' })
    expect(filterTrigger(trigger, ruleSemantic, denied))
      .toMatchObject({ action: 'drop', layer: 'fast', reason: 'group-not-allowlisted' })
    // A message from a different chat is denied under the original allowlist.
    expect(filterTrigger(
      feishuTriggerFromMessage(message({ chat_id: 'oc_other' }), config),
      ruleSemantic,
      allowed,
    )).toMatchObject({ action: 'drop', layer: 'fast', reason: 'group-not-allowlisted' })
  })

  it('maps p2p direct mode without address.group and addressed=direct', () => {
    const prev = process.env.DS_AGENT_FEISHU_P2P_DIRECT
    process.env.DS_AGENT_FEISHU_P2P_DIRECT = '1'
    try {
      const trigger = feishuTriggerFromMessage(message({
        body: { content: JSON.stringify({ text: '你好' }) },
      }), config)
      expect(trigger.addressed).toBe('direct')
      expect(trigger.channel?.address?.group).toBeUndefined()
      expect(filterTrigger(trigger, ruleSemantic)).toMatchObject({ action: 'pass', strength: 'explicit' })
    } finally {
      if (prev === undefined) delete process.env.DS_AGENT_FEISHU_P2P_DIRECT
      else process.env.DS_AGENT_FEISHU_P2P_DIRECT = prev
    }
  })

  it('treats an app sender as non-human and detects bot mention ids', () => {
    const trigger = feishuTriggerFromMessage(message({
      sender: { id: 'ou_bot', sender_type: 'app' },
      body: { content: JSON.stringify({ text: 'deploy finished' }) },
      mentions: [{ id: { open_id: 'ou_bot' }, name: 'ds-agent' }],
    }), config)
    expect(trigger.human).toBe(false)
    expect(trigger.addressed).toBe('mention')
  })
})

describe('Feishu webhook parser', () => {
  it('answers url_verification with the challenge', () => {
    expect(parseFeishuWebhook({
      type: 'url_verification',
      token: 'verify-me',
      challenge: 'challenge-123',
    }, config)).toEqual({ challenge: 'challenge-123' })
  })

  it('rejects a wrong verification token', () => {
    expect(() => parseFeishuWebhook({
      type: 'url_verification',
      token: 'wrong',
      challenge: 'x',
    }, config)).toThrow(/token mismatch/)
  })

  it('maps im.message.receive_v1 to a Trigger', () => {
    const result = parseFeishuWebhook({
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1', token: 'verify-me' },
      event: {
        sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user', tenant_key: 't1' },
        message: {
          message_id: 'om_webhook',
          chat_id: 'oc_chat',
          msg_type: 'text',
          content: JSON.stringify({ text: '@ds-agent investigate this timeout' }),
          create_time: '1761958800000',
        },
      },
    }, config)
    expect(result.trigger?.id).toBe('feishu_om_webhook')
    expect(result.trigger?.actor.id).toBe('ou_alice')
    expect(result.trigger?.threads[0]?.id).toBe('feishu:oc_chat')
  })

  it('decrypts an encrypted envelope', () => {
    const plain = JSON.stringify({
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1', token: 'verify-me' },
      event: {
        sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user' },
        message: {
          message_id: 'om_enc',
          chat_id: 'oc_chat',
          msg_type: 'text',
          content: JSON.stringify({ text: '@ds-agent encrypted hello' }),
          create_time: '1761958800000',
        },
      },
    })
    expect(decryptFeishuPayload(encrypt(plain, 'encrypt-key'), 'encrypt-key')).toBe(plain)
    const result = parseFeishuWebhook({ encrypt: encrypt(plain, 'encrypt-key') }, config)
    expect(result.trigger?.text).toBe('@ds-agent encrypted hello')
  })

  it('ignores unrelated events', () => {
    expect(parseFeishuWebhook({
      schema: '2.0',
      header: { event_type: 'im.chat.updated_v1', token: 'verify-me' },
      event: {},
    }, config)).toEqual({ ignored: 'im.chat.updated_v1' })
  })
})

describe('Feishu client and outbox', () => {
  it('caches the tenant token and sends text to a chat', async () => {
    const { fn, calls } = fakeFetch((url, init) => {
      if (url.includes('tenant_access_token')) return tokenHandler(url, init)
      return { body: { code: 0, data: { message_id: 'om_sent' } } }
    })
    const client = new FeishuClient(config, fn)
    const result = await client.sendText('oc_chat', 'hello')
    expect(result.message_id).toBe('om_sent')
    expect(calls.filter(call => call.url.includes('tenant_access_token'))).toHaveLength(1)
    const send = calls.find(call => call.url.includes('/im/v1/messages?'))!
    expect(send.url).toContain('receive_id_type=chat_id')
    expect(JSON.parse(String(send.init?.body))).toEqual({
      receive_id: 'oc_chat',
      msg_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
    })
    expect((send.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok_1')
  })

  it('replies in-thread when a message id is present', async () => {
    const { fn, calls } = fakeFetch((url, init) => {
      if (url.includes('tenant_access_token')) return tokenHandler(url, init)
      return { body: { code: 0, data: { message_id: 'om_reply' } } }
    })
    const client = new FeishuClient(config, fn)
    const adapter = new FeishuOutboxAdapter(client)
    const row: OutboxRow = {
      id: 'outbox_1',
      replyId: 'reply_1',
      ticketId: 'ticket_1',
      channel: 'im',
      thread: 'feishu:oc_chat',
      target: { provider: 'feishu', chat_id: 'oc_chat', message_id: 'om_1' },
      text: 'short reply',
      status: 'pending',
      createdAt: new Date().toISOString(),
    }
    const result = await adapter.send(row)
    expect(result.externalId).toBe('om_reply')
    expect(calls.some(call => call.url.endsWith('/im/v1/messages/om_1/reply'))).toBe(true)
  })

  it('polls a real chat through FeishuSource and maps messages to Triggers', async () => {
    const { fn } = fakeFetch((url, init) => {
      if (url.includes('tenant_access_token')) return tokenHandler(url, init)
      return {
        body: {
          code: 0,
          data: {
            has_more: false,
            items: [
              message({ message_id: 'om_a', create_time: '1761958800000' }),
              message({ message_id: 'om_b', create_time: '1761958860000', body: { content: JSON.stringify({ text: 'second' }) } }),
            ],
          },
        },
      }
    })
    const client = new FeishuClient(config, fn)
    const source = new FeishuSource(client, 'oc_chat', { sinceMs: 1761958000000, config })
    const triggers = await source.pull()
    expect(triggers.map(trigger => trigger.id)).toEqual(['feishu_om_a', 'feishu_om_b'])
    expect(triggers[1]!.text).toBe('second')
  })

  it('surfaces a Feishu API error instead of dropping it', async () => {
    const { fn } = fakeFetch(url => url.includes('tenant_access_token')
      ? { body: { code: 0, tenant_access_token: 'tok', expire: 7200 } }
      : { body: { code: 230002, msg: 'bot not in chat' } })
    const client = new FeishuClient(config, fn)
    await expect(client.sendText('oc_chat', 'hi')).rejects.toThrow(/230002/)
  })
})

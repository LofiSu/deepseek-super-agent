import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  APPLE_EPOCH_OFFSET_SECONDS,
  ChatDbImessageApi,
  ImessageOutboxAdapter,
  ImessageSource,
  appleDateToIso,
  decodeAttributedBody,
  imessageThreadFor,
  imessageTrigger,
  osascriptEnv,
  type ImessageApi,
  type ImessageInbound,
  type ImessagePullOptions,
} from '../src/channels/imessage.ts'
import type { OutboxRow } from '../src/shared/types.ts'

function sample(over: Partial<ImessageInbound> = {}): ImessageInbound {
  return {
    rowId: 10,
    guid: 'GUID-1',
    text: 'hello ds-agent',
    handle: '+8613800000000',
    service: 'iMessage',
    chatGuid: 'iMessage;-;+8613800000000',
    at: '2026-11-02T08:00:00.000Z',
    ...over,
  }
}

class FakeImessage implements ImessageApi {
  sent: { target: { handle?: string; chatGuid?: string }; text: string }[] = []

  constructor(private readonly messages: ImessageInbound[] = []) {}

  async pull(afterRowId: number, opts: ImessagePullOptions = {}): Promise<ImessageInbound[]> {
    return this.messages.filter(message =>
      message.rowId > afterRowId && (!opts.handle || message.handle === opts.handle))
  }

  async maxRowId(): Promise<number> {
    return this.messages.reduce((max, message) => Math.max(max, message.rowId), 0)
  }

  async send(target: { handle?: string; chatGuid?: string }, text: string): Promise<{ externalId: string }> {
    this.sent.push({ target, text })
    return { externalId: 'ext_1' }
  }
}

describe('iMessage date + body decoding', () => {
  it('converts Apple-epoch dates (nanoseconds and seconds) to ISO', () => {
    expect(appleDateToIso(0)).toBe('2001-01-01T00:00:00.000Z')
    expect(appleDateToIso(1)).toBe('2001-01-01T00:00:01.000Z')
    // 1e18 ns and 1e9 s denote the same instant.
    expect(appleDateToIso(1e18)).toBe(appleDateToIso(1e9))
    expect(new Date(appleDateToIso(1e9)).getTime()).toBe((1e9 + APPLE_EPOCH_OFFSET_SECONDS) * 1000)
  })

  it('falls back to attributedBody when text is null', () => {
    const blob = Buffer.concat([
      Buffer.from('\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+'),
      Buffer.from('book a table for two'),
    ])
    expect(decodeAttributedBody(blob)).toContain('book a table for two')
  })
})

describe('iMessage trigger mapping', () => {
  it('maps an inbound message to an addressed imessage Trigger', () => {
    const trigger = imessageTrigger(sample())
    expect(trigger.id).toBe('imessage_GUID-1')
    expect(trigger.source).toBe('imessage')
    expect(trigger.addressed).toBe('direct')
    expect(trigger.human).toBe(true)
    expect(trigger.actor).toEqual({ source: 'imessage', id: '+8613800000000' })
    expect(trigger.threads).toEqual([{ source: 'imessage', id: 'chat:iMessage;-;+8613800000000' }])
    expect(trigger.channel?.address).toMatchObject({ provider: 'imessage', handle: '+8613800000000' })
  })

  it('uses a handle thread when there is no chat guid', () => {
    expect(imessageThreadFor({ handle: 'a@b.com' })).toBe('handle:a@b.com')
    expect(imessageThreadFor({ handle: 'a@b.com', chatGuid: 'g1' })).toBe('chat:g1')
  })
})

describe('iMessage source pull', () => {
  it('returns triggers in row order and advances the cursor', async () => {
    const api = new FakeImessage([
      sample({ rowId: 5 }),
      sample({ rowId: 9, guid: 'GUID-2', text: 'second' }),
    ])
    const result = await new ImessageSource(api).pull(0)
    expect(result.triggers.map(trigger => trigger.id)).toEqual(['imessage_GUID-1', 'imessage_GUID-2'])
    expect(result.lastRowId).toBe(9)
  })

  it('can restrict to one sender handle', async () => {
    const api = new FakeImessage([
      sample({ rowId: 1, handle: 'x' }),
      sample({ rowId: 2, guid: 'G2', handle: 'y' }),
    ])
    const result = await new ImessageSource(api, { handle: 'y' }).pull(0)
    expect(result.triggers.map(trigger => trigger.id)).toEqual(['imessage_G2'])
  })

  it('advances the cursor past empty rows without emitting empty Triggers', async () => {
    const api = new FakeImessage([
      sample({ rowId: 1 }),
      sample({ rowId: 2, guid: 'G2', text: '   ' }),
      sample({ rowId: 3, guid: 'G3', text: 'second' }),
    ])
    const result = await new ImessageSource(api).pull(0)
    expect(result.triggers.map(trigger => trigger.id)).toEqual(['imessage_GUID-1', 'imessage_G3'])
    expect(result.messages.map(message => message.rowId)).toEqual([1, 3])
    expect(result.lastRowId).toBe(3)
  })
})

describe('ChatDbImessageApi pull', () => {
  it('ignores rows with no payload and never stalls the ROWID cursor on an empty decode', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-imessage-'))
    const dbPath = path.join(dir, 'chat.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
        date INTEGER, service TEXT, handle_id INTEGER, is_from_me INTEGER
      );
      CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
    `)
    db.exec(`
      INSERT INTO handle (ROWID, id) VALUES (1, '+15550000000');
      INSERT INTO chat (ROWID, guid, chat_identifier) VALUES (1, 'iMessage;-;+15550000000', '+15550000000');
      -- 1: normal text; 2: tapback/attachment with no text columns;
      -- 3: attributedBody that decodes to nothing (must still advance the cursor).
      INSERT INTO message VALUES (1, 'G1', 'first message', NULL, 0, 'iMessage', 1, 0);
      INSERT INTO message VALUES (2, 'G2', NULL, NULL, 0, 'iMessage', 1, 0);
      INSERT INTO message VALUES (3, 'G3', NULL, x'010203', 0, 'iMessage', 1, 0);
      INSERT INTO message VALUES (4, 'G4', 'fourth message', NULL, 0, 'iMessage', 1, 0);
      INSERT INTO message VALUES (5, 'G5', 'from the agent', NULL, 0, 'iMessage', 1, 1);
      INSERT INTO chat_message_join VALUES (1, 1), (2, 1), (3, 1), (4, 1), (5, 1);
    `)
    const api = new ChatDbImessageApi(dbPath)
    try {
      const rows = await api.pull(0)
      expect(rows.map(row => row.rowId)).toEqual([1, 3, 4])
      expect(rows.map(row => row.text)).toEqual(['first message', '', 'fourth message'])

      const pulled = await new ImessageSource(api).pull(0)
      expect(pulled.triggers.map(trigger => trigger.id)).toEqual(['imessage_G1', 'imessage_G4'])
      expect(pulled.lastRowId).toBe(4)
      expect(await api.pull(pulled.lastRowId)).toEqual([])
    } finally {
      api.close()
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

function outboxRow(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 'o1',
    replyId: 'r1',
    ticketId: 't1',
    channel: 'imessage',
    thread: 'chat:x',
    target: { provider: 'imessage', handle: '+8613800000000' },
    text: 'ds-agent reply',
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...over,
  }
}

describe('iMessage outbound', () => {
  it('sends the outbox row back to the same conversation', async () => {
    const api = new FakeImessage()
    const adapter = new ImessageOutboxAdapter(api)
    const result = await adapter.send(outboxRow())
    expect(result.externalId).toBe('ext_1')
    expect(api.sent).toEqual([{ target: { handle: '+8613800000000' }, text: 'ds-agent reply' }])
  })

  it('prefers the chat guid when present', async () => {
    const api = new FakeImessage()
    const adapter = new ImessageOutboxAdapter(api)
    await adapter.send(outboxRow({ target: { provider: 'imessage', handle: '+1', chatGuid: 'iMessage;-;+1' } }))
    expect(api.sent[0]!.target).toEqual({ chatGuid: 'iMessage;-;+1' })
  })

  it('rejects a row without a target', async () => {
    const api = new FakeImessage()
    const adapter = new ImessageOutboxAdapter(api)
    await expect(adapter.send(outboxRow({ target: {} }))).rejects.toThrow(/target/)
  })
})

describe('ChatDbImessageApi send', () => {
  it('passes text and target through the environment, not the script', async () => {
    const captured: { script: string; env: NodeJS.ProcessEnv }[] = []
    const api = new ChatDbImessageApi('/tmp/unused.db', async (script, env) => {
      captured.push({ script, env })
      return 'ok'
    })
    const result = await api.send({ handle: '+1' }, 'hi "quoted" $HOME')
    expect(captured).toHaveLength(1)
    expect(captured[0]!.script).not.toContain('hi "quoted"')
    expect(captured[0]!.env.DS_AGENT_IMSG_TEXT).toBe('hi "quoted" $HOME')
    expect(captured[0]!.env.DS_AGENT_IMSG_TARGET).toBe('+1')
    expect(captured[0]!.env.DS_AGENT_IMSG_MODE).toBe('buddy')
    expect(result.externalId).toMatch(/^imessage_/)
  })

  it('uses chat mode for a chat guid target', async () => {
    let mode = ''
    const api = new ChatDbImessageApi('/tmp/unused.db', async (_script, env) => {
      mode = String(env.DS_AGENT_IMSG_MODE)
      return ''
    })
    await api.send({ chatGuid: 'iMessage;-;+1' }, 'hi')
    expect(mode).toBe('chat')
  })

  it('does not leak provider credentials into the osascript child env', () => {
    const env = osascriptEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/test',
      DEEPSEEK_API_KEY: 'sk-secret',
      DS_AGENT_GATEWAY_TOKEN: 'gw_secret',
      DS_AGENT_IMSG_TEXT: 'hi',
    })
    expect(env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/Users/test', DS_AGENT_IMSG_TEXT: 'hi' })
  })
})

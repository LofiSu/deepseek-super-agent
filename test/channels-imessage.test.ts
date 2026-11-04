import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  APPLE_EPOCH_OFFSET_SECONDS,
  ChatDbImessageApi,
  IMESSAGE_ADMISSION_ERROR,
  IMESSAGE_GROUP_CHAT_STYLE,
  ImessageOutboxAdapter,
  ImessageSchemaError,
  ImessageSource,
  appleDateToIso,
  decideImessageAdmission,
  decodeAttributedBody,
  imessageThreadFor,
  imessageTrigger,
  isGroupMessage,
  osascriptEnv,
  runOsascript,
  type ImessageApi,
  type ImessageInbound,
  type ImessagePullOptions,
} from '../src/channels/imessage.ts'
import { PermanentDeliveryError } from '../src/channels/outbox-adapter.ts'
import { resolveImessageHandle, runImessageCommand } from '../src/cli/imessage.ts'
import type { OutboxRow } from '../src/shared/types.ts'
import { freshRuntime, shutdown } from './fixtures.ts'

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
    // 1:1 addresses keep the sender handle and an optional chat guid unchanged.
    expect(trigger.channel?.address).toEqual({
      provider: 'imessage',
      handle: '+8613800000000',
      chatGuid: 'iMessage;-;+8613800000000',
    })
  })

  it('uses a handle thread when there is no chat guid', () => {
    expect(imessageThreadFor({ handle: 'a@b.com' })).toBe('handle:a@b.com')
    expect(imessageThreadFor({ handle: 'a@b.com', chatGuid: 'g1' })).toBe('chat:g1')
  })

  it('marks only 1:1 messages as direct', () => {
    expect(imessageTrigger(sample()).addressed).toBe('direct')
    const group = imessageTrigger(sample({
      guid: 'G-GROUP',
      chatGuid: 'iMessage;+;chat123',
      chatIdentifier: 'chat123',
      isGroup: true,
      roomName: 'Team',
    }))
    expect(group.addressed).toBeUndefined()
    // A group address never carries the sender handle: the adapter would send
    // that handle in buddy (1:1) mode and leak the group reply as a DM.
    expect(group.channel?.address).toEqual({
      provider: 'imessage',
      chatGuid: 'iMessage;+;chat123',
      group: 'iMessage;+;chat123',
    })
  })

  it('detects a group from chat.db metadata, never from text', () => {
    expect(isGroupMessage({ chatStyle: IMESSAGE_GROUP_CHAT_STYLE })).toBe(true)
    expect(isGroupMessage({ roomName: 'Team' })).toBe(true)
    expect(isGroupMessage({ isGroup: true })).toBe(true)
    expect(isGroupMessage({ chatStyle: 45, roomName: '' })).toBe(false)
    expect(imessageTrigger(sample({ chatStyle: IMESSAGE_GROUP_CHAT_STYLE })).addressed).toBeUndefined()
    expect(imessageTrigger(sample({ roomName: 'Team' })).addressed).toBeUndefined()
  })

  it('leaves the group address unset when no chat row supplies one', () => {
    const group = imessageTrigger(sample({
      guid: 'G-NO-CHAT',
      chatGuid: undefined,
      chatIdentifier: undefined,
      isGroup: true,
    }))
    expect(group.addressed).toBeUndefined()
    expect(group.channel?.address?.group).toBeUndefined()
  })

  it('keeps an ambiguous group thread separate from a 1:1 thread for the same handle', () => {
    const handle = '+8613800000000'
    const direct = imessageTrigger(sample({ guid: 'G-DIRECT', handle, chatGuid: undefined }))
    const ambiguousGroup = imessageTrigger(sample({
      guid: 'G-AMBIGUOUS',
      handle,
      chatGuid: undefined,
      chatIdentifier: undefined,
      chatRowId: 7001,
      isGroup: true,
    }))
    expect(direct.threads[0]!.id).toBe(`handle:${handle}`)
    expect(direct.channel?.thread).toBe(`handle:${handle}`)
    expect(ambiguousGroup.threads[0]!.id).toBe('group-rowid:7001')
    expect(ambiguousGroup.channel?.thread).toBe('group-rowid:7001')
    expect(ambiguousGroup.threads[0]!.id).not.toBe(direct.threads[0]!.id)
    expect(ambiguousGroup.threads[0]!.id).not.toBe(`handle:${handle}`)
  })

  it('keys distinct legacy group chats by chat.ROWID even for the same sender', () => {
    const handle = '+8613800000000'
    const first = imessageTrigger(sample({
      guid: 'G-LEGACY-1',
      handle,
      chatGuid: undefined,
      chatIdentifier: undefined,
      chatRowId: 41,
      isGroup: true,
    }))
    const second = imessageTrigger(sample({
      guid: 'G-LEGACY-2',
      handle,
      chatGuid: undefined,
      chatIdentifier: undefined,
      chatRowId: 42,
      isGroup: true,
    }))
    const direct = imessageTrigger(sample({ guid: 'G-DIRECT', handle, chatGuid: undefined }))
    expect(first.threads[0]!.id).toBe('group-rowid:41')
    expect(second.threads[0]!.id).toBe('group-rowid:42')
    expect(first.channel?.thread).toBe('group-rowid:41')
    expect(second.channel?.thread).toBe('group-rowid:42')
    // The two legacy groups must not collapse into one thread...
    expect(first.threads[0]!.id).not.toBe(second.threads[0]!.id)
    // ...and neither may equal the 1:1 thread of the shared sender.
    expect(first.threads[0]!.id).not.toBe(`handle:${handle}`)
    expect(second.threads[0]!.id).not.toBe(`handle:${handle}`)
    expect(direct.threads[0]!.id).toBe(`handle:${handle}`)
  })

  it('keeps the chat.ROWID thread stable for repeated messages in one group', () => {
    const first = imessageTrigger(sample({
      guid: 'G-STABLE-1',
      chatGuid: undefined,
      chatIdentifier: undefined,
      chatRowId: 41,
      isGroup: true,
    }))
    const second = imessageTrigger(sample({
      guid: 'G-STABLE-2',
      chatGuid: undefined,
      chatIdentifier: undefined,
      chatRowId: 41,
      isGroup: true,
    }))
    expect(first.threads[0]!.id).toBe('group-rowid:41')
    expect(second.threads[0]!.id).toBe('group-rowid:41')
  })

  it('ignores chatRowId when a guid or identifier is present', () => {
    const handle = '+8613800000000'
    const byGuid = imessageThreadFor({
      handle,
      isGroup: true,
      chatGuid: 'iMessage;+;chat-guid',
      chatRowId: 9,
    })
    const byIdentifier = imessageThreadFor({
      handle,
      isGroup: true,
      chatIdentifier: 'chat123',
      chatRowId: 9,
    })
    const byRowId = imessageThreadFor({ handle, isGroup: true, chatRowId: 9 })
    const direct = imessageThreadFor({ handle })
    expect(byGuid).toBe('chat:iMessage;+;chat-guid')
    expect(byIdentifier).toBe('group:chat123')
    expect(byRowId).toBe('group-rowid:9')
    // Precedence: guid > identifier > rowid > handle. All four keys are
    // distinct, and no group key collides with the 1:1 key.
    expect(new Set([byGuid, byIdentifier, byRowId, direct]).size).toBe(4)
    // A whitespace-only identifier is not positive, so the rowid applies.
    expect(imessageThreadFor({
      handle,
      isGroup: true,
      chatIdentifier: '   ',
      chatRowId: 9,
    })).toBe('group-rowid:9')
  })

  it('never uses chatRowId for a 1:1 message', () => {
    const trigger = imessageTrigger(sample({
      guid: 'G-1TO1-ROWID',
      chatGuid: undefined,
      chatRowId: 77,
    }))
    expect(trigger.addressed).toBe('direct')
    expect(trigger.threads[0]!.id).toBe('handle:+8613800000000')
    expect(trigger.channel?.thread).toBe('handle:+8613800000000')
    expect(imessageThreadFor({ handle: 'a@b.com', isGroup: false, chatRowId: 77 }))
      .toBe('handle:a@b.com')
  })

  it('falls back to group-unknown for unusable chat rowids', () => {
    for (const chatRowId of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(imessageThreadFor({ handle: '+1', isGroup: true, chatRowId }))
        .toBe('group-unknown:+1')
    }
    // Absent rowid and a whitespace-only identifier also fall back.
    expect(imessageThreadFor({ handle: '+1', isGroup: true })).toBe('group-unknown:+1')
    expect(imessageThreadFor({ handle: '+1', isGroup: true, chatIdentifier: '   ' }))
      .toBe('group-unknown:+1')
    const trigger = imessageTrigger(sample({
      guid: 'G-BAD-ROWID',
      chatGuid: undefined,
      chatIdentifier: undefined,
      chatRowId: Number.NaN,
      isGroup: true,
    }))
    expect(trigger.threads[0]!.id).toBe('group-unknown:+8613800000000')
  })

  it('uses a group identifier thread when a positive group row has no guid', () => {
    const group = imessageTrigger(sample({
      guid: 'G-ID-ONLY',
      chatGuid: undefined,
      chatIdentifier: 'chat123',
      isGroup: true,
      roomName: 'Team',
    }))
    expect(group.threads[0]!.id).toBe('group:chat123')
    expect(group.channel?.thread).toBe('group:chat123')
    expect(imessageThreadFor({ handle: '+1', chatIdentifier: 'chat123', isGroup: true }))
      .toBe('group:chat123')
  })

  it('keeps the chat guid thread for a group that has a guid', () => {
    const group = imessageTrigger(sample({
      guid: 'G-GUID',
      chatGuid: 'iMessage;+;chat123',
      chatIdentifier: 'chat123',
      isGroup: true,
      roomName: 'Team',
    }))
    expect(group.threads[0]!.id).toBe('chat:iMessage;+;chat123')
    expect(group.channel?.thread).toBe('chat:iMessage;+;chat123')
  })

  it('keeps the existing thread keys for 1:1 messages', () => {
    expect(imessageThreadFor({ handle: 'a@b.com', isGroup: false })).toBe('handle:a@b.com')
    expect(imessageThreadFor({ handle: 'a@b.com', chatGuid: 'g1', isGroup: false })).toBe('chat:g1')
    // A chat identifier alone never becomes a group key for a 1:1 message.
    expect(imessageThreadFor({ handle: 'a@b.com', chatIdentifier: 'direct-id', isGroup: false }))
      .toBe('handle:a@b.com')
    expect(imessageTrigger(sample({ guid: 'G-1TO1-NOGUID', chatGuid: undefined })).threads[0]!.id)
      .toBe('handle:+8613800000000')
  })
})

describe('iMessage admission decision', () => {
  it('refuses by default and names the safe flags', () => {
    const decision = decideImessageAdmission({})
    expect(decision.allowed).toBe(false)
    expect(decision.error).toBe(IMESSAGE_ADMISSION_ERROR)
    expect(decision.error).toContain('--handle "+..."')
    expect(decision.error).toContain('DS_AGENT_ACTOR_ALLOWLIST')
    expect(decision.error).toContain('--allow-any')
    expect(decision.error).toContain('DS_AGENT_IMESSAGE_ALLOW_ANY=1')
  })

  it('accepts a handle, a non-empty actor allowlist, or explicit opt-out', () => {
    expect(decideImessageAdmission({ handle: '+15551234567' }))
      .toMatchObject({ allowed: true, senders: ['+15551234567'] })
    expect(decideImessageAdmission({ actorAllowlist: ' +1 , a@b.com , ' }))
      .toMatchObject({ allowed: true, senders: ['+1', 'a@b.com'] })
    expect(decideImessageAdmission({ allowAny: true }))
      .toMatchObject({ allowed: true, allowAny: true })
  })

  it('treats an empty actor allowlist as no allowlist', () => {
    expect(decideImessageAdmission({ actorAllowlist: ' , ' }).allowed).toBe(false)
  })
})

describe('iMessage CLI admission', () => {
  it('refuses to start without an allowlist before touching the database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-imessage-cli-'))
    const dbPath = path.join(dir, 'missing-chat.db')
    const argv = process.argv
    const saved = {
      handle: process.env.DS_AGENT_IMESSAGE_HANDLE,
      actors: process.env.DS_AGENT_ACTOR_ALLOWLIST,
      allowAny: process.env.DS_AGENT_IMESSAGE_ALLOW_ANY,
    }
    try {
      process.argv = ['node', 'ds-agent', 'imessage', '--once', '--db', dbPath]
      delete process.env.DS_AGENT_IMESSAGE_HANDLE
      delete process.env.DS_AGENT_ACTOR_ALLOWLIST
      delete process.env.DS_AGENT_IMESSAGE_ALLOW_ANY
      let error: unknown
      try {
        await runImessageCommand(dir)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('--handle "+..."')
      expect((error as Error).message).toContain('DS_AGENT_ACTOR_ALLOWLIST')
      expect(fs.existsSync(dbPath)).toBe(false)
    } finally {
      process.argv = argv
      for (const [name, value] of [
        ['DS_AGENT_IMESSAGE_HANDLE', saved.handle],
        ['DS_AGENT_ACTOR_ALLOWLIST', saved.actors],
        ['DS_AGENT_IMESSAGE_ALLOW_ANY', saved.allowAny],
      ] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('trims DS_AGENT_IMESSAGE_HANDLE once for admission and the source filter', async () => {
    const handle = resolveImessageHandle([], { DS_AGENT_IMESSAGE_HANDLE: '  +15551234567  ' })
    expect(handle).toBe('+15551234567')
    expect(decideImessageAdmission({ handle }).senders).toEqual(['+15551234567'])
    // The trimmed id is what the SQL/source filter matches, not the padded env.
    const api = new FakeImessage([sample({ rowId: 1, handle: '+15551234567' })])
    const pulled = await new ImessageSource(api, { handle: handle! }).pull(0)
    expect(pulled.triggers.map(trigger => trigger.id)).toEqual(['imessage_GUID-1'])
  })

  it('rejects missing, flag-like, and whitespace-only handles instead of idling', () => {
    expect(() => resolveImessageHandle(['--handle', '--once'], {}))
      .toThrow(/--handle needs a non-empty sender id/)
    expect(() => resolveImessageHandle(['--handle'], {}))
      .toThrow(/--handle needs a non-empty sender id/)
    expect(() => resolveImessageHandle(['--handle', '   '], {}))
      .toThrow(/--handle needs a non-empty sender id/)
    expect(() => resolveImessageHandle([], { DS_AGENT_IMESSAGE_HANDLE: '   ' }))
      .toThrow(/DS_AGENT_IMESSAGE_HANDLE must be a non-empty sender id/)
    expect(() => resolveImessageHandle([], { DS_AGENT_IMESSAGE_HANDLE: ' --allow-any ' }))
      .toThrow(/DS_AGENT_IMESSAGE_HANDLE must be a non-empty sender id/)
  })

  it('refuses a whitespace-only env handle before touching the database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-imessage-cli-'))
    const dbPath = path.join(dir, 'missing-chat.db')
    const argv = process.argv
    const saved = {
      handle: process.env.DS_AGENT_IMESSAGE_HANDLE,
      actors: process.env.DS_AGENT_ACTOR_ALLOWLIST,
    }
    try {
      process.argv = ['node', 'ds-agent', 'imessage', '--once', '--db', dbPath]
      process.env.DS_AGENT_IMESSAGE_HANDLE = '   '
      delete process.env.DS_AGENT_ACTOR_ALLOWLIST
      await expect(runImessageCommand(dir)).rejects.toThrow(/DS_AGENT_IMESSAGE_HANDLE/)
      expect(fs.existsSync(dbPath)).toBe(false)
    } finally {
      process.argv = argv
      if (saved.handle === undefined) delete process.env.DS_AGENT_IMESSAGE_HANDLE
      else process.env.DS_AGENT_IMESSAGE_HANDLE = saved.handle
      if (saved.actors === undefined) delete process.env.DS_AGENT_ACTOR_ALLOWLIST
      else process.env.DS_AGENT_ACTOR_ALLOWLIST = saved.actors
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('iMessage runtime admission', () => {
  it('drops an unallowlisted direct trigger even though it is 1:1', async () => {
    const runtime = freshRuntime({ env: { DS_AGENT_ACTOR_ALLOWLIST: 'trusted@example.com' } })
    try {
      expect(runtime.ingest(imessageTrigger(sample({
        guid: 'G-DENY',
        handle: '+15550001111',
      })))).toBe('filtered')
      expect(runtime.ingest(imessageTrigger(sample({
        guid: 'G-ALLOW',
        handle: 'trusted@example.com',
      })))).toBe('stored')
      const text = runtime.log.text()
      expect(text).toContain('actor-not-allowlisted')
    } finally {
      await shutdown(runtime)
    }
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

  it('skips group messages by default and includes them only when opened', async () => {
    const api = new FakeImessage([
      sample({ rowId: 1 }),
      sample({
        rowId: 2,
        guid: 'G-GROUP',
        chatGuid: 'iMessage;+;chat123',
        isGroup: true,
        roomName: 'Team',
      }),
      sample({ rowId: 3, guid: 'G3', text: 'third' }),
    ])
    const closed = await new ImessageSource(api).pull(0)
    expect(closed.triggers.map(trigger => trigger.id)).toEqual(['imessage_GUID-1', 'imessage_G3'])
    // The cursor still advances past the skipped group row.
    expect(closed.lastRowId).toBe(3)

    const open = await new ImessageSource(api, { allowGroups: true }).pull(0)
    expect(open.triggers.map(trigger => trigger.id))
      .toEqual(['imessage_GUID-1', 'imessage_G-GROUP', 'imessage_G3'])
    expect(open.triggers[1]!.addressed).toBeUndefined()
  })
})

describe('ChatDbImessageApi pull', () => {
  it('ignores rows with no payload and never stalls the ROWID cursor on an empty decode', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-imessage-'))
    const dbPath = path.join(dir, 'chat.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER, room_name TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
        date INTEGER, service TEXT, handle_id INTEGER, is_from_me INTEGER
      );
      CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
    `)
    db.exec(`
      INSERT INTO handle (ROWID, id) VALUES (1, '+15550000000');
      INSERT INTO chat (ROWID, guid, chat_identifier, style) VALUES (1, 'iMessage;-;+15550000000', '+15550000000', 45);
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

  it('reads macOS nanosecond dates that exceed Number.MAX_SAFE_INTEGER', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-imessage-date-'))
    const dbPath = path.join(dir, 'chat.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER, room_name TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
        date INTEGER, service TEXT, handle_id INTEGER, is_from_me INTEGER
      );
      CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
    `)
    // A real macOS 14+ timestamp: nanoseconds since 2001, ~8.15e17. node:sqlite
    // throws converting this column to a JS number unless the statement reads
    // integers as BigInt, which would stall the poll loop on every new message.
    db.exec(`
      INSERT INTO handle (ROWID, id) VALUES (1, '+15550000000');
      INSERT INTO chat (ROWID, guid, chat_identifier, style) VALUES (1, 'iMessage;-;+15550000000', '+15550000000', 45);
      INSERT INTO message VALUES (1, 'G1', 'nanosecond date', NULL, 815487932020665600, 'iMessage', 1, 0);
      INSERT INTO chat_message_join VALUES (1, 1);
    `)
    const api = new ChatDbImessageApi(dbPath)
    try {
      const rows = await api.pull(0)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.rowId).toBe(1)
      expect(rows[0]?.at).toBe('2026-11-04T12:25:32.020Z')
      expect(rows[0]?.isGroup).toBe(false)
    } finally {
      api.close()
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads group metadata from chat.style and chat.room_name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-imessage-group-'))
    const dbPath = path.join(dir, 'chat.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER, room_name TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
        date INTEGER, service TEXT, handle_id INTEGER, is_from_me INTEGER
      );
      CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
    `)
    db.exec(`
      INSERT INTO handle (ROWID, id) VALUES (1, '+15550000000');
      INSERT INTO chat VALUES (1, 'iMessage;-;+15550000000', '+15550000000', 45, NULL);
      INSERT INTO chat VALUES (2, 'iMessage;+;chat123', 'chat123', 43, 'Team');
      INSERT INTO chat VALUES (3, 'iMessage;+;chat456', 'chat456', 45, 'Named room');
      INSERT INTO message VALUES (1, 'G1', 'one to one', NULL, 0, 'iMessage', 1, 0);
      INSERT INTO message VALUES (2, 'G2', 'group by style', NULL, 0, 'iMessage', 1, 0);
      INSERT INTO message VALUES (3, 'G3', 'group by room name', NULL, 0, 'iMessage', 1, 0);
      INSERT INTO chat_message_join VALUES (1, 1), (2, 2), (3, 3);
    `)
    const api = new ChatDbImessageApi(dbPath)
    try {
      const rows = await api.pull(0)
      expect(rows.map(row => row.isGroup)).toEqual([false, true, true])

      const closed = await new ImessageSource(api).pull(0)
      expect(closed.triggers.map(trigger => trigger.id)).toEqual(['imessage_G1'])
      expect(closed.lastRowId).toBe(3)

      const open = await new ImessageSource(api, { allowGroups: true }).pull(0)
      expect(open.triggers.map(trigger => trigger.id)).toEqual(['imessage_G1', 'imessage_G2', 'imessage_G3'])
      expect(open.triggers.map(trigger => trigger.addressed)).toEqual(['direct', undefined, undefined])
    } finally {
      api.close()
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('aggregates all joined chats: a message in a 1:1 and a group is a group', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-imessage-both-'))
    const dbPath = path.join(dir, 'chat.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER, room_name TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
        date INTEGER, service TEXT, handle_id INTEGER, is_from_me INTEGER
      );
      CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
    `)
    db.exec(`
      INSERT INTO handle (ROWID, id) VALUES (1, '+15550000000');
      INSERT INTO chat VALUES (1, 'iMessage;-;+15550000000', '+15550000000', 45, NULL);
      INSERT INTO chat VALUES (2, 'iMessage;+;chat123', 'chat123', 43, 'Team');
      INSERT INTO message VALUES (1, 'G1', 'joined both', NULL, 0, 'iMessage', 1, 0);
      INSERT INTO message VALUES (2, 'G2', 'direct only', NULL, 0, 'iMessage', 1, 0);
      -- The 1:1 join sorts first; taking the first row's metadata would say direct.
      INSERT INTO chat_message_join VALUES (1, 1), (1, 2), (2, 1);
    `)
    const api = new ChatDbImessageApi(dbPath)
    try {
      const rows = await api.pull(0)
      expect(rows.map(row => row.guid)).toEqual(['G1', 'G2'])
      expect(rows.map(row => row.isGroup)).toEqual([true, false])
      expect(rows[0]).toMatchObject({ chatGuid: 'iMessage;+;chat123', chatIdentifier: 'chat123' })
      expect(rows[1]).toMatchObject({ chatGuid: 'iMessage;-;+15550000000' })

      const closed = await new ImessageSource(api).pull(0)
      expect(closed.triggers.map(trigger => trigger.id)).toEqual(['imessage_G2'])
      expect(closed.lastRowId).toBe(2)

      const open = await new ImessageSource(api, { allowGroups: true }).pull(0)
      expect(open.triggers.map(trigger => trigger.id)).toEqual(['imessage_G1', 'imessage_G2'])
      expect(open.triggers.map(trigger => trigger.addressed)).toEqual([undefined, 'direct'])
      expect(open.triggers[0]!.channel?.address).toMatchObject({ group: 'iMessage;+;chat123' })
    } finally {
      api.close()
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('disambiguates legacy group chats with no guid or identifier by chat.ROWID', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-imessage-group-rowid-'))
    const dbPath = path.join(dir, 'chat.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER, room_name TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
        date INTEGER, service TEXT, handle_id INTEGER, is_from_me INTEGER
      );
      CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
    `)
    db.exec(`
      INSERT INTO handle (ROWID, id) VALUES (1, '+15550000000');
      -- Two positive group rows with no guid and no identifier. Only their
      -- per-database ROWID tells these conversations apart.
      INSERT INTO chat VALUES (1, NULL, NULL, 43, 'Team A');
      INSERT INTO chat VALUES (2, NULL, NULL, 43, 'Team B');
      -- A guid-less 1:1 chat keys by the sender handle, the namespace the
      -- group rows must never leak into.
      INSERT INTO chat VALUES (3, NULL, '+15550000000', 45, NULL);
      INSERT INTO message VALUES (1, 'G1', 'group A', NULL, 0, 'iMessage', 1, 0);
      INSERT INTO message VALUES (2, 'G2', 'group B', NULL, 0, 'iMessage', 1, 0);
      INSERT INTO message VALUES (3, 'G3', 'direct', NULL, 0, 'iMessage', 1, 0);
      INSERT INTO chat_message_join VALUES (1, 1), (2, 2), (3, 3);
    `)
    const api = new ChatDbImessageApi(dbPath)
    try {
      const rows = await api.pull(0)
      expect(rows.map(row => row.guid)).toEqual(['G1', 'G2', 'G3'])
      expect(rows.map(row => row.isGroup)).toEqual([true, true, false])
      expect(rows.map(row => row.chatRowId)).toEqual([1, 2, undefined])

      const open = await new ImessageSource(api, { allowGroups: true }).pull(0)
      const threads = open.triggers.map(trigger => trigger.threads[0]!.id)
      expect(threads).toEqual([
        'group-rowid:1',
        'group-rowid:2',
        'handle:+15550000000',
      ])
      // The two legacy groups are distinct from each other...
      expect(threads[0]).not.toBe(threads[1])
      // ...and neither may equal the 1:1 thread of the shared sender.
      expect(threads[0]).not.toBe('handle:+15550000000')
      expect(threads[1]).not.toBe('handle:+15550000000')
      // The ROWID key is thread-only: the group address still fails closed.
      expect(open.triggers[0]!.addressed).toBeUndefined()
      expect(open.triggers[1]!.addressed).toBeUndefined()
      expect(open.triggers[0]!.channel?.address).toEqual({ provider: 'imessage' })
      expect(open.triggers[1]!.channel?.address).toEqual({ provider: 'imessage' })
      expect(open.triggers[0]!.channel?.address?.chatGuid).toBeUndefined()
      expect(open.triggers[0]!.channel?.address?.group).toBeUndefined()
    } finally {
      api.close()
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('takes the group ROWID, never a joined 1:1 ROWID, for thread identity', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-imessage-group-rowid-join-'))
    const dbPath = path.join(dir, 'chat.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER, room_name TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
        date INTEGER, service TEXT, handle_id INTEGER, is_from_me INTEGER
      );
      CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
    `)
    db.exec(`
      INSERT INTO handle (ROWID, id) VALUES (1, '+15550000000');
      -- The 1:1 chat ROWID (1) sorts first. The positive group row (ROWID 2)
      -- has no guid/identifier, so only its own ROWID is usable.
      INSERT INTO chat VALUES (1, 'iMessage;-;+15550000000', '+15550000000', 45, NULL);
      INSERT INTO chat VALUES (2, NULL, NULL, 43, 'Team');
      INSERT INTO message VALUES (1, 'G1', 'joined both', NULL, 0, 'iMessage', 1, 0);
      INSERT INTO chat_message_join VALUES (1, 1), (1, 2);
    `)
    const api = new ChatDbImessageApi(dbPath)
    try {
      const rows = await api.pull(0)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ guid: 'G1', isGroup: true, chatRowId: 2 })
      expect(rows[0]!.chatRowId).not.toBe(1)
      expect(rows[0]!.chatGuid).toBeUndefined()

      const open = await new ImessageSource(api, { allowGroups: true }).pull(0)
      expect(open.triggers).toHaveLength(1)
      expect(open.triggers[0]!.threads[0]!.id).toBe('group-rowid:2')
      expect(open.triggers[0]!.channel?.thread).toBe('group-rowid:2')
      // The 1:1 chat's guid is not group identity and must not leak out.
      expect(open.triggers[0]!.channel?.address).toEqual({ provider: 'imessage' })
    } finally {
      api.close()
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the positive group address when the 1:1 join sorts first', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-imessage-order-'))
    const dbPath = path.join(dir, 'chat.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER, room_name TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
        date INTEGER, service TEXT, handle_id INTEGER, is_from_me INTEGER
      );
      CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
    `)
    db.exec(`
      INSERT INTO handle (ROWID, id) VALUES (1, '+15550000000');
      INSERT INTO chat VALUES (1, 'iMessage;-;+15550000000', '+15550000000', 45, NULL);
      INSERT INTO chat VALUES (2, 'iMessage;+;chat123', 'chat123', 43, 'Team');
      INSERT INTO message VALUES (1, 'G1', 'joined both', NULL, 0, 'iMessage', 1, 0);
      -- The 1:1 chat ROWID sorts first; the positive group row must still win.
      INSERT INTO chat_message_join VALUES (1, 1), (1, 2);
    `)
    const api = new ChatDbImessageApi(dbPath)
    try {
      const rows = await api.pull(0)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        guid: 'G1',
        isGroup: true,
        chatGuid: 'iMessage;+;chat123',
        chatIdentifier: 'chat123',
      })

      const open = await new ImessageSource(api, { allowGroups: true }).pull(0)
      expect(open.triggers).toHaveLength(1)
      expect(open.triggers[0]!.addressed).toBeUndefined()
      expect(open.triggers[0]!.channel?.address).toMatchObject({
        group: 'iMessage;+;chat123',
        chatGuid: 'iMessage;+;chat123',
      })
    } finally {
      api.close()
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prefers a later positive group guid over an identifier-only positive row', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-imessage-group-guid-late-'))
    const dbPath = path.join(dir, 'chat.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER, room_name TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
        date INTEGER, service TEXT, handle_id INTEGER, is_from_me INTEGER
      );
      CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
    `)
    db.exec(`
      INSERT INTO handle (ROWID, id) VALUES (1, '+15550000000');
      -- The identifier-only positive group row sorts first; the later positive
      -- row still carries a usable chat guid.
      INSERT INTO chat VALUES (1, NULL, 'chat-id-only', 43, 'Team');
      INSERT INTO chat VALUES (2, 'iMessage;+;chat-guid', 'chat-guid', 43, 'Team');
      INSERT INTO message VALUES (1, 'G1', 'joined two group rows', NULL, 0, 'iMessage', 1, 0);
      INSERT INTO chat_message_join VALUES (1, 1), (1, 2);
    `)
    const api = new ChatDbImessageApi(dbPath)
    try {
      const rows = await api.pull(0)
      expect(rows).toHaveLength(1)
      // The first non-empty identifier wins, but the guid is aggregated
      // independently and must not be blocked by the identifier-only row.
      expect(rows[0]).toMatchObject({
        guid: 'G1',
        isGroup: true,
        chatGuid: 'iMessage;+;chat-guid',
        chatIdentifier: 'chat-id-only',
      })

      const open = await new ImessageSource(api, { allowGroups: true }).pull(0)
      expect(open.triggers).toHaveLength(1)
      expect(open.triggers[0]!.addressed).toBeUndefined()
      expect(open.triggers[0]!.channel?.address).toEqual({
        provider: 'imessage',
        chatGuid: 'iMessage;+;chat-guid',
        group: 'iMessage;+;chat-guid',
      })
      expect(open.triggers[0]!.channel?.address?.handle).toBeUndefined()
    } finally {
      api.close()
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not reuse the 1:1 chat guid when the positive group row has no guid', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-imessage-noguid-'))
    const dbPath = path.join(dir, 'chat.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER, room_name TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
        date INTEGER, service TEXT, handle_id INTEGER, is_from_me INTEGER
      );
      CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
    `)
    db.exec(`
      INSERT INTO handle (ROWID, id) VALUES (1, '+15550000000');
      INSERT INTO chat VALUES (1, 'iMessage;-;+15550000000', '+15550000000', 45, NULL);
      -- A positive style-43/room-name group row may lack a guid; only its own
      -- identifier may be used, never the 1:1 chat's guid.
      INSERT INTO chat VALUES (2, NULL, 'chat123', 43, 'Team');
      INSERT INTO message VALUES (1, 'G1', 'group without guid', NULL, 0, 'iMessage', 1, 0);
      INSERT INTO chat_message_join VALUES (1, 1), (1, 2);
    `)
    const api = new ChatDbImessageApi(dbPath)
    try {
      const rows = await api.pull(0)
      expect(rows[0]).toMatchObject({ isGroup: true, chatIdentifier: 'chat123' })
      expect(rows[0]!.chatGuid).toBeUndefined()

      const open = await new ImessageSource(api, { allowGroups: true }).pull(0)
      expect(open.triggers[0]!.channel?.address).toMatchObject({ group: 'chat123' })
      expect(open.triggers[0]!.channel?.address?.chatGuid).toBeUndefined()
      expect(open.triggers[0]!.channel?.address?.group).not.toBe('iMessage;-;+15550000000')
    } finally {
      api.close()
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('aggregates every joined chat when a page boundary lands on the message', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-imessage-page-'))
    const dbPath = path.join(dir, 'chat.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER, room_name TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
        date INTEGER, service TEXT, handle_id INTEGER, is_from_me INTEGER
      );
      CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
    `)
    db.exec(`
      INSERT INTO handle (ROWID, id) VALUES (1, '+15550000000');
      INSERT INTO chat VALUES (1, 'iMessage;-;+15550000000', '+15550000000', 45, NULL);
      INSERT INTO chat VALUES (2, 'iMessage;+;chat123', 'chat123', 43, 'Team');
      INSERT INTO message VALUES (1, 'G1', 'joined both', NULL, 0, 'iMessage', 1, 0);
      INSERT INTO message VALUES (2, 'G2', 'direct only', NULL, 0, 'iMessage', 1, 0);
      INSERT INTO chat_message_join VALUES (1, 1), (1, 2), (2, 1);
    `)
    const api = new ChatDbImessageApi(dbPath)
    try {
      // ROWID pages are over messages, so a page ending at message 1 must still
      // carry both of its joined chats and classify it exactly once.
      const first = await api.pull(0, { limit: 1 })
      expect(first.map(row => row.guid)).toEqual(['G1'])
      expect(first[0]).toMatchObject({ isGroup: true, chatGuid: 'iMessage;+;chat123' })

      const second = await api.pull(1, { limit: 1 })
      expect(second.map(row => row.guid)).toEqual(['G2'])
      expect(second[0]!.isGroup).toBe(false)
    } finally {
      api.close()
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not leak a 1:1 chat guid across a page boundary for an ambiguous group', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-imessage-page-unknown-'))
    const dbPath = path.join(dir, 'chat.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER, room_name TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
        date INTEGER, service TEXT, handle_id INTEGER, is_from_me INTEGER
      );
      CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
    `)
    db.exec(`
      INSERT INTO handle (ROWID, id) VALUES (1, '+15550000000');
      INSERT INTO chat VALUES (1, 'iMessage;-;+15550000000', '+15550000000', 45, NULL);
      INSERT INTO chat VALUES (2, 'iMessage;+;chatunknown', 'chatunknown', NULL, NULL);
      INSERT INTO message VALUES (1, 'G1', 'ambiguous join', NULL, 0, 'iMessage', 1, 0);
      INSERT INTO message VALUES (2, 'G2', 'direct only', NULL, 0, 'iMessage', 1, 0);
      INSERT INTO chat_message_join VALUES (1, 1), (1, 2), (2, 1);
    `)
    const api = new ChatDbImessageApi(dbPath)
    try {
      const first = await api.pull(0, { limit: 1 })
      expect(first).toHaveLength(1)
      expect(first[0]).toMatchObject({ guid: 'G1', isGroup: true })
      expect(first[0]!.chatGuid).toBeUndefined()
      expect(first[0]!.chatIdentifier).toBeUndefined()

      const open = await new ImessageSource(api, { allowGroups: true, limit: 1 }).pull(0)
      expect(open.triggers).toHaveLength(1)
      expect(open.triggers[0]!.addressed).toBeUndefined()
      expect(open.triggers[0]!.channel?.address?.group).toBeUndefined()
    } finally {
      api.close()
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never exposes the 1:1 chat guid for a group-then-1:1 ambiguous join', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-imessage-ambiguous-first-'))
    const dbPath = path.join(dir, 'chat.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER, room_name TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
        date INTEGER, service TEXT, handle_id INTEGER, is_from_me INTEGER
      );
      CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
    `)
    db.exec(`
      INSERT INTO handle (ROWID, id) VALUES (1, '+15550000000');
      -- The ambiguous/group-looking join sorts first, the 1:1 chat second.
      INSERT INTO chat VALUES (1, 'iMessage;+;chatunknown', 'chatunknown', NULL, NULL);
      INSERT INTO chat VALUES (2, 'iMessage;-;+15550000000', '+15550000000', 45, NULL);
      INSERT INTO message VALUES (1, 'G1', 'ambiguous first', NULL, 0, 'iMessage', 1, 0);
      INSERT INTO chat_message_join VALUES (1, 1), (1, 2);
    `)
    const api = new ChatDbImessageApi(dbPath)
    try {
      const rows = await api.pull(0)
      expect(rows[0]).toMatchObject({ guid: 'G1', isGroup: true })
      expect(rows[0]!.chatGuid).toBeUndefined()
      expect(rows[0]!.chatIdentifier).toBeUndefined()

      const open = await new ImessageSource(api, { allowGroups: true }).pull(0)
      expect(open.triggers[0]!.addressed).toBeUndefined()
      expect(open.triggers[0]!.channel?.address?.group).toBeUndefined()
    } finally {
      api.close()
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats a missing chat row and ambiguous metadata as group/unknown', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-imessage-unknown-'))
    const dbPath = path.join(dir, 'chat.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER, room_name TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
        date INTEGER, service TEXT, handle_id INTEGER, is_from_me INTEGER
      );
      CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
    `)
    db.exec(`
      INSERT INTO handle (ROWID, id) VALUES (1, '+15550000000');
      -- 43 with a NULL room name is still a group at the DB level.
      INSERT INTO chat VALUES (1, 'iMessage;+;chat43null', 'chat43null', 43, NULL);
      -- Neither a known group style nor a known 1:1 style is ambiguous.
      INSERT INTO chat VALUES (2, 'iMessage;+;chatunknown', 'chatunknown', NULL, NULL);
      INSERT INTO message VALUES (1, 'G1', 'no chat row', NULL, 0, 'iMessage', 1, 0);
      INSERT INTO message VALUES (2, 'G2', 'style 43 null room', NULL, 0, 'iMessage', 1, 0);
      INSERT INTO message VALUES (3, 'G3', 'unknown metadata', NULL, 0, 'iMessage', 1, 0);
      INSERT INTO chat_message_join VALUES (2, 1), (3, 2);
    `)
    const api = new ChatDbImessageApi(dbPath)
    try {
      const rows = await api.pull(0)
      expect(rows.map(row => row.isGroup)).toEqual([true, true, true])
      expect(rows[0]!.chatGuid).toBeUndefined()
      expect(rows[1]).toMatchObject({ chatGuid: 'iMessage;+;chat43null' })
      // Ambiguous metadata is still group/unknown, but it is not a positive
      // group address and must not be published as one.
      expect(rows[2]!.chatGuid).toBeUndefined()
      expect(rows[2]!.chatIdentifier).toBeUndefined()

      const closed = await new ImessageSource(api).pull(0)
      expect(closed.triggers).toEqual([])
      expect(closed.lastRowId).toBe(3)

      const open = await new ImessageSource(api, { allowGroups: true }).pull(0)
      expect(open.triggers.map(trigger => trigger.addressed)).toEqual([undefined, undefined, undefined])
      expect(open.triggers[1]!.channel?.address).toMatchObject({ group: 'iMessage;+;chat43null' })
    } finally {
      api.close()
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails once with a compatibility error when chat.style/room_name are absent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-imessage-schema-'))
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
      INSERT INTO chat VALUES (1, 'iMessage;-;+15550000000', '+15550000000');
      INSERT INTO message VALUES (1, 'G1', 'hello', NULL, 0, 'iMessage', 1, 0);
      INSERT INTO chat_message_join VALUES (1, 1);
    `)
    const api = new ChatDbImessageApi(dbPath)
    try {
      const first = await api.pull(0).catch(error => error)
      expect(first).toBeInstanceOf(ImessageSchemaError)
      expect((first as Error).message).toContain('not compatible')
      expect((first as Error).message).toContain('chat.style, chat.room_name')
      // The cached failure is rethrown; the incompatible query is not retried.
      const second = await api.pull(0).catch(error => error)
      expect(second).toBe(first)
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

  it('never DMs the sender for an ambiguous group and the outbox rejects it', async () => {
    const trigger = imessageTrigger(sample({
      guid: 'G-AMBIGUOUS',
      chatGuid: undefined,
      chatIdentifier: undefined,
      chatRowId: 7001,
      isGroup: true,
    }))
    expect(trigger.addressed).toBeUndefined()
    // The group now has a distinct rowid thread key, but that key is not an
    // outbound address: the address must stay unset and fail closed.
    expect(trigger.threads[0]!.id).toBe('group-rowid:7001')
    // The pre-fix construction always emitted `handle`, so this exact shape and
    // the zero-send assertion below both fail against it.
    expect(trigger.channel?.address).toEqual({ provider: 'imessage' })
    expect(trigger.channel?.address?.handle).toBeUndefined()
    expect(trigger.channel?.address?.chatGuid).toBeUndefined()
    expect(trigger.channel?.address?.group).toBeUndefined()
    // The sender is still available to admission as the actor.
    expect(trigger.actor).toEqual({ source: 'imessage', id: '+8613800000000' })

    const api = new FakeImessage()
    const adapter = new ImessageOutboxAdapter(api)
    await expect(adapter.send(outboxRow({ target: { ...trigger.channel!.address! } })))
      .rejects.toThrow(/no target\.handle or target\.chatGuid/)
    expect(api.sent).toHaveLength(0)
  })

  it('rejects a positive group row that only carries a chat identifier', async () => {
    const trigger = imessageTrigger(sample({
      guid: 'G-ID-ONLY',
      chatGuid: undefined,
      chatIdentifier: 'chat123',
      isGroup: true,
      roomName: 'Team',
    }))
    expect(trigger.addressed).toBeUndefined()
    expect(trigger.channel?.address).toEqual({ provider: 'imessage', group: 'chat123' })
    expect(trigger.channel?.address?.handle).toBeUndefined()
    expect(trigger.channel?.address?.chatGuid).toBeUndefined()

    const api = new FakeImessage()
    const adapter = new ImessageOutboxAdapter(api)
    await expect(adapter.send(outboxRow({ target: { ...trigger.channel!.address! } })))
      .rejects.toThrow(/targets group chat123 without a chatGuid/)
    expect(api.sent).toHaveLength(0)
  })

  it('rejects a group row that still carries a handle instead of DMing it', async () => {
    const api = new FakeImessage()
    const adapter = new ImessageOutboxAdapter(api)
    // Defense in depth: even a target that still has a sender handle must not
    // fall back to buddy (1:1) mode when it is marked as a group row.
    await expect(adapter.send(outboxRow({
      target: { provider: 'imessage', handle: '+8613800000000', group: 'chat123' },
    }))).rejects.toThrow(/targets group chat123 without a chatGuid/)
    expect(api.sent).toHaveLength(0)
  })

  it('rejects a group row without a chatGuid as a permanent delivery failure', async () => {
    const api = new FakeImessage()
    const adapter = new ImessageOutboxAdapter(api)
    const error = await adapter.send(outboxRow({
      target: { provider: 'imessage', handle: '+8613800000000', group: 'iMessage;+;chat123' },
    })).catch(caught => caught)
    expect(error).toBeInstanceOf(PermanentDeliveryError)
    expect((error as Error).message).toMatch(/targets group iMessage;\+;chat123 without a chatGuid/)
    expect(api.sent).toHaveLength(0)
  })

  it('sends a group reply in chat mode and never falls back to the sender handle', async () => {
    const trigger = imessageTrigger(sample({
      guid: 'G-GUID',
      chatGuid: 'iMessage;+;chat123',
      chatIdentifier: 'chat123',
      isGroup: true,
      roomName: 'Team',
    }))
    expect(trigger.addressed).toBeUndefined()
    expect(trigger.channel?.address).toEqual({
      provider: 'imessage',
      chatGuid: 'iMessage;+;chat123',
      group: 'iMessage;+;chat123',
    })
    expect(trigger.channel?.address?.handle).toBeUndefined()

    const api = new FakeImessage()
    const adapter = new ImessageOutboxAdapter(api)
    await adapter.send(outboxRow({ target: { ...trigger.channel!.address! } }))
    expect(api.sent).toHaveLength(1)
    expect(api.sent[0]!.target).toEqual({ chatGuid: 'iMessage;+;chat123' })
    expect(api.sent[0]!.target.handle).toBeUndefined()
  })

  it('still sends a 1:1 reply to the sender handle when there is no chat guid', async () => {
    const trigger = imessageTrigger(sample({ guid: 'G-DIRECT', chatGuid: undefined }))
    expect(trigger.addressed).toBe('direct')
    expect(trigger.channel?.address).toEqual({ provider: 'imessage', handle: '+8613800000000' })

    const api = new FakeImessage()
    const adapter = new ImessageOutboxAdapter(api)
    await adapter.send(outboxRow({ target: { ...trigger.channel!.address! } }))
    expect(api.sent).toEqual([{ target: { handle: '+8613800000000' }, text: 'ds-agent reply' }])
  })
})

describe('ChatDbImessageApi send', () => {
  it('passes text as an argv item, not through the environment', async () => {
    const captured: { script: string; env: NodeJS.ProcessEnv; args: readonly string[] }[] = []
    const api = new ChatDbImessageApi('/tmp/unused.db', async (script, env, args = []) => {
      captured.push({ script, env, args })
      return 'ok'
    })
    const result = await api.send({ handle: '+1' }, 'hi "quoted" $HOME')
    expect(captured).toHaveLength(1)
    expect(captured[0]!.script).not.toContain('hi "quoted"')
    expect(captured[0]!.script).toContain('item 1 of argv')
    expect(captured[0]!.args).toEqual(['hi "quoted" $HOME'])
    expect(captured[0]!.env.DS_AGENT_IMSG_TEXT).toBeUndefined()
    expect(captured[0]!.env.DS_AGENT_IMSG_TARGET).toBe('+1')
    expect(captured[0]!.env.DS_AGENT_IMSG_MODE).toBe('buddy')
    expect(result.externalId).toMatch(/^imessage_/)
  })

  it('delivers non-ASCII text as UTF-8 through osascript argv', async () => {
    // AppleScript's `system attribute` decodes the env with the system encoding,
    // which turned every Chinese reply into mojibake on a real Mac. argv is UTF-8.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-osascript-'))
    const fake = path.join(dir, 'osascript')
    fs.writeFileSync(fake, '#!/bin/sh\nfor arg in "$@"; do printf "%s\\n" "$arg"; done\n', { mode: 0o755 })
    try {
      const text = '你好，测试 normal text'
      const out = await runOsascript('on run argv\nreturn item 1 of argv\nend run', { PATH: dir }, [text])
      expect(out.split('\n')).toContain(text)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
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

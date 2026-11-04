import { spawn } from 'node:child_process'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PermanentDeliveryError, type OutboundAdapter } from './outbox-adapter.ts'
import type { OutboxRow, Trigger } from '../shared/types.ts'

/**
 * Real iMessage channel.
 *
 * Inbound reads `~/Library/Messages/chat.db` (read-only). That requires the
 * process to hold macOS **Full Disk Access**. Outbound drives `Messages.app`
 * through `osascript`, which requires **Automation** permission. Message text
 * is passed to AppleScript through the environment, never interpolated into
 * the script, so quotes/`$`/newlines cannot break out.
 *
 * This is meant for a dedicated Apple ID / number that acts as the agent's
 * identity: the human texts that handle, the Mac (signed into that account)
 * reads the incoming messages (`is_from_me = 0`) and replies back to the same
 * conversation. Because outbound rows are `is_from_me = 1`, the agent never
 * re-ingests its own replies.
 */

/** macOS stores message dates as nanoseconds since 2001-01-01T00:00:00Z. */
export const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200

export const DEFAULT_IMESSAGE_INTERVAL_MS = 2_000

export interface ImessageInbound {
  rowId: number
  guid: string
  text: string
  /** Sender handle (phone/email). For a dedicated account this is the human. */
  handle: string
  service?: string
  chatGuid?: string
  chatIdentifier?: string
  /**
   * `chat.ROWID` of a positive group chat row. SQLite row identity local to
   * one chat.db (not a global id); used only as a last-resort thread key and
   * never as an outbound address.
   */
  chatRowId?: number
  /** `chat.style` from chat.db. `43` denotes a group chat. */
  chatStyle?: number
  /** `chat.room_name` from chat.db; non-empty for a named group chat. */
  roomName?: string
  /** True when chat.db metadata says this row belongs to a group chat. */
  isGroup?: boolean
  /** ISO timestamp derived from the Apple-epoch `date` column. */
  at: string
}

export interface ImessageTarget {
  handle?: string
  chatGuid?: string
}

export interface ImessagePullOptions {
  /** Page size (1..200). */
  limit?: number
  /** Only ingest messages whose sender handle equals this (safety allowlist). */
  handle?: string
  /** Only ingest messages that belong to this chat guid. */
  chatGuid?: string
  /**
   * Ingest group-chat messages. Off by default, so a group message is skipped
   * before it can become a Trigger. Even when enabled a group message is never
   * marked `addressed: 'direct'`.
   */
  allowGroups?: boolean
}

/** chat.db `chat.style` value for a group chat (1:1 chats use 45). */
export const IMESSAGE_GROUP_CHAT_STYLE = 43

/** chat.db `chat.style` value for a known 1:1 chat. */
export const IMESSAGE_DIRECT_CHAT_STYLE = 45

/**
 * Raised when chat.db lacks the `chat.style` / `chat.room_name` columns this
 * channel needs to tell 1:1 messages from group messages. It is cached and
 * rethrown, so a poll loop neither re-queries the schema nor guesses 1:1.
 */
export class ImessageSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImessageSchemaError'
  }
}

function nonEmptyText(value: unknown): string | undefined {
  if (value == null) return undefined
  const text = String(value)
  return text.trim() === '' ? undefined : text
}

/**
 * Accept only a positive SQLite row identity. Zero, negatives, fractions, NaN,
 * and non-numeric junk are rejected so a malformed join cannot mint a thread
 * key that might collide with another conversation.
 */
function safeChatRowId(value: unknown): number | undefined {
  if (typeof value === 'bigint') {
    return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return undefined
  return value
}

/**
 * Group detection uses chat.db metadata only (`chat.style`, `chat.room_name`),
 * never message text. Any positive signal wins, so an inconsistent row fails
 * closed as a group.
 */
export function isGroupMessage(message: {
  isGroup?: boolean
  chatStyle?: number
  roomName?: string
}): boolean {
  if (message.isGroup === true) return true
  if (Number(message.chatStyle) === IMESSAGE_GROUP_CHAT_STYLE) return true
  return typeof message.roomName === 'string' && message.roomName.trim().length > 0
}

export interface ImessageAdmissionInput {
  /** `--handle <id>` or `DS_AGENT_IMESSAGE_HANDLE`. */
  handle?: string
  /** Raw `DS_AGENT_ACTOR_ALLOWLIST` (comma-separated). */
  actorAllowlist?: string
  /** `--allow-any` or `DS_AGENT_IMESSAGE_ALLOW_ANY=1`. */
  allowAny?: boolean
}

export interface ImessageAdmissionDecision {
  allowed: boolean
  allowAny: boolean
  /** Trimmed sender ids from `--handle` plus a non-empty actor allowlist. */
  senders: string[]
  /** Refusal text when `allowed` is false. */
  error?: string
}

/** Safe refusal shown when the channel would otherwise be default-open. */
export const IMESSAGE_ADMISSION_ERROR =
  'iMessage channel refuses to start without a sender allowlist: '
  + 'pass --handle "+..." (your phone number or Apple ID email) or set DS_AGENT_ACTOR_ALLOWLIST, '
  + 'or opt into open use with --allow-any (DS_AGENT_IMESSAGE_ALLOW_ANY=1).'

function parseAllowlist(raw: string | undefined): string[] {
  if (raw == null || raw.trim() === '') return []
  return raw.split(',').map(id => id.trim()).filter(id => id.length > 0)
}

/**
 * Default-deny startup gate for the iMessage CLI. This is not authorization:
 * the runtime admission rules still evaluate every Trigger. It only refuses a
 * configuration that would otherwise ingest messages from any sender.
 */
export function decideImessageAdmission(
  input: ImessageAdmissionInput = {},
): ImessageAdmissionDecision {
  const senders = [input.handle, ...parseAllowlist(input.actorAllowlist)]
    .map(value => value?.trim() ?? '')
    .filter(value => value.length > 0)
  const allowAny = input.allowAny === true
  if (allowAny || senders.length > 0) {
    return { allowed: true, allowAny, senders }
  }
  return { allowed: false, allowAny: false, senders, error: IMESSAGE_ADMISSION_ERROR }
}

export interface ImessageApi {
  pull(afterRowId: number, opts?: ImessagePullOptions): Promise<ImessageInbound[]>
  /** Current max message ROWID, used to seed the cursor on first run. */
  maxRowId(): Promise<number>
  send(target: ImessageTarget, text: string): Promise<{ externalId: string }>
}

export function imessageDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DS_AGENT_IMESSAGE_DB?.trim() || path.join(env.HOME ?? '', 'Library/Messages/chat.db')
}

/** Apple-epoch date column -> ISO. Handles both nanosecond (new) and second (old) rows. */
export function appleDateToIso(raw: unknown): string {
  if (raw == null || raw === '') return new Date(0).toISOString()
  const value = Number(raw)
  if (!Number.isFinite(value)) return new Date(0).toISOString()
  const seconds = value > 1e12 ? value / 1e9 : value
  return new Date((seconds + APPLE_EPOCH_OFFSET_SECONDS) * 1000).toISOString()
}

/**
 * Best-effort decoder for an `attributedBody` blob (typedstream NSAttributedString).
 * `message.text` is often NULL on macOS 13+; we take the longest printable run
 * after the `NSString` marker. Rich formatting and attachments are out of scope.
 */
export function decodeAttributedBody(blob: unknown): string {
  if (blob == null) return ''
  const bytes = Buffer.isBuffer(blob)
    ? blob
    : blob instanceof Uint8Array ? Buffer.from(blob) : Buffer.from(String(blob))
  const text = bytes.toString('utf8')
  const marker = text.lastIndexOf('NSString')
  const scan = marker >= 0 ? text.slice(marker + 'NSString'.length) : text
  let best = ''
  let run = ''
  for (const char of scan) {
    const code = char.codePointAt(0) ?? 0
    const printable = code === 0x0a || code === 0x09 || (code >= 0x20 && code !== 0x7f)
    if (printable) {
      run += char
    } else {
      if (run.length > best.length) best = run
      run = ''
    }
  }
  if (run.length > best.length) best = run
  // The typedstream payload prefixes the real text with a lone '+' token.
  return best.replace(/^[\u0000-\u001f]+/, '').replace(/^\+/, '').trim()
}

/**
 * Conversation key for a message, in strict precedence order:
 *
 * 1. a chat guid → `chat:<guid>`;
 * 2. a group with a positive chat identifier → `group:<identifier>`;
 * 3. a group with a positive `chat.ROWID` → `group-rowid:<rowid>`;
 * 4. any other group → `group-unknown:<handle>`.
 *
 * A 1:1 message is always `handle:<handle>` and never consults `chatRowId`.
 * Every group key is namespaced away from 1:1 traffic, so a group message can
 * never share a thread with a 1:1 message from the same sender.
 */
export function imessageThreadFor(message: {
  handle: string
  chatGuid?: string
  chatIdentifier?: string
  chatRowId?: number
  isGroup?: boolean
}): string {
  if (message.chatGuid) return `chat:${message.chatGuid}`
  if (message.isGroup === true) {
    const identifier = nonEmptyText(message.chatIdentifier)
    if (identifier) return `group:${identifier}`
    const rowId = safeChatRowId(message.chatRowId)
    return rowId !== undefined ? `group-rowid:${rowId}` : `group-unknown:${message.handle}`
  }
  return `handle:${message.handle}`
}

/**
 * Map a real inbound message to a Trigger. Only a 1:1 message is addressed
 * directly; group messages and messages whose chat metadata is missing or
 * ambiguous are not. "Direct" describes the conversation shape, not a verified
 * sender: the SQL `handle` filter may be unset (for example when
 * `DS_AGENT_ACTOR_ALLOWLIST` is the gate), so runtime admission still evaluates
 * the actor allowlist for every Trigger.
 */
export function imessageTrigger(message: ImessageInbound): Trigger {
  const group = isGroupMessage(message)
  // A group message without a chat guid must not share the 1:1 `handle:`
  // namespace, so `imessageThreadFor` receives the resolved group flag, the
  // positive chat identifier, and (for groups only) the positive group row's
  // ROWID. The ROWID only refines the thread key; it is never an address.
  const thread = imessageThreadFor({
    handle: message.handle,
    chatGuid: message.chatGuid,
    chatIdentifier: message.chatIdentifier,
    ...(group ? { chatRowId: message.chatRowId } : {}),
    isGroup: group,
  })
  // A group address must come from a positive group chat row. Falling back to
  // the thread (or a joined 1:1 chat's guid) would let an ambiguous group reply
  // into a direct conversation, so leave it unset and let admission fail closed.
  // `chatRowId` is deliberately never an address: it is a local SQLite identity
  // with no Messages.app send target, so a group-rowid thread still has no
  // outbound target.
  const groupId = group ? message.chatGuid ?? message.chatIdentifier : undefined
  // A group address deliberately omits the sender `handle`. The outbox adapter
  // sends a handle target in buddy (1:1) mode, so copying the sender handle
  // from a group message would leak group content into a direct conversation.
  // Group replies may only use a chat guid; otherwise they fail closed.
  const address: Record<string, string> = group
    ? {
        provider: 'imessage',
        ...(message.chatGuid ? { chatGuid: message.chatGuid } : {}),
        // Group admission reads only `address.group`; a group message is never
        // direct and must earn its way through the normal filter. Only a
        // positive group chat row can supply this address.
        ...(groupId ? { group: groupId } : {}),
      }
    : {
        provider: 'imessage',
        handle: message.handle,
        ...(message.chatGuid ? { chatGuid: message.chatGuid } : {}),
      }
  return {
    id: `imessage_${message.guid}`,
    source: 'imessage',
    threads: [{ source: 'imessage', id: thread }],
    actor: { source: 'imessage', id: message.handle },
    human: true,
    ...(group ? {} : { addressed: 'direct' as const }),
    at: message.at,
    text: message.text,
    channel: {
      source: 'imessage',
      thread,
      address,
    },
    meta: {},
  }
}

/**
 * Pulls new inbound messages and maps them to Triggers, advancing the ROWID
 * cursor. Group messages are dropped unless `allowGroups` is set; the cursor
 * still advances past them so a closed group can never stall the poll.
 */
export class ImessageSource {
  constructor(
    private readonly api: ImessageApi,
    private readonly opts: ImessagePullOptions = {},
  ) {}

  async pull(afterRowId: number): Promise<{
    messages: ImessageInbound[]
    triggers: Trigger[]
    lastRowId: number
  }> {
    const messages = await this.api.pull(afterRowId, this.opts)
    let lastRowId = afterRowId
    for (const message of messages) {
      if (message.rowId > lastRowId) lastRowId = message.rowId
    }
    // Advance past rows that decoded to no text (reactions, attachment-only
    // payloads) or belong to a closed group, without turning them into Triggers.
    const usable = messages.filter(message =>
      message.text.trim().length > 0
      && (this.opts.allowGroups === true || !isGroupMessage(message)))
    return { messages: usable, triggers: usable.map(imessageTrigger), lastRowId }
  }
}

export type OsascriptRunner = (script: string, env: NodeJS.ProcessEnv) => Promise<string>

/** Env names osascript needs; everything else (provider keys, tokens) stays out. */
const OSASCRIPT_ENV = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR'])

/** Keep API keys and other process secrets out of the osascript child process. */
export function osascriptEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (OSASCRIPT_ENV.has(name) || name.startsWith('DS_AGENT_IMSG_')) childEnv[name] = value
  }
  return childEnv
}

/** Production runner: spawn `osascript` with the script on argv and text/target through env. */
export const runOsascript: OsascriptRunner = (script, env) => new Promise((resolve, reject) => {
  const child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'], env: osascriptEnv(env) })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer | string) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk: Buffer | string) => { stderr += String(chunk) })
  child.on('error', error => reject(new Error(`cannot run osascript: ${error.message}`)))
  child.on('close', code => {
    if (code === 0) {
      resolve(stdout.trim())
      return
    }
    reject(new Error(
      `osascript failed (exit ${code}): ${(stderr || stdout).trim().slice(0, 400)}. `
      + 'Grant the host app Automation permission to control Messages '
      + '(System Settings > Privacy & Security > Automation).',
    ))
  })
})

const APPLE_SEND_SCRIPT = `on run
  set theText to system attribute "DS_AGENT_IMSG_TEXT"
  set theTarget to system attribute "DS_AGENT_IMSG_TARGET"
  set theMode to system attribute "DS_AGENT_IMSG_MODE"
  tell application "Messages"
    if theMode is "chat" then
      send theText to chat id theTarget
    else
      set theService to 1st service whose service type = iMessage
      send theText to buddy theTarget of theService
    end if
  end tell
end run`

let externalSeq = 0
function nextExternalId(): string {
  externalSeq += 1
  return `imessage_${Date.now().toString(36)}_${externalSeq}`
}

/** Real API: reads chat.db read-only and sends through Messages.app. */
export class ChatDbImessageApi implements ImessageApi {
  private db?: DatabaseSync
  private schemaChecked = false
  private schemaError?: ImessageSchemaError

  constructor(
    private readonly dbPath: string = imessageDbPath(),
    private readonly run: OsascriptRunner = runOsascript,
  ) {}

  private open(): DatabaseSync {
    if (this.db) return this.db
    try {
      this.db = new DatabaseSync(this.dbPath, { readOnly: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `cannot open iMessage database ${this.dbPath}: ${message}. Grant Full Disk Access to the app `
        + 'running this process (System Settings > Privacy & Security > Full Disk Access), then retry.',
      )
    }
    return this.db
  }

  /**
   * Check the chat metadata columns once per connection and cache the result.
   * Without `style`/`room_name` there is no safe way to tell a group from a
   * 1:1 chat, so this fails closed instead of running a query that would make
   * every row look direct on every poll.
   */
  private ensureChatSchema(db: DatabaseSync): void {
    if (this.schemaChecked) {
      if (this.schemaError) throw this.schemaError
      return
    }
    const columns = db.prepare('PRAGMA table_info(chat)').all() as Array<{ name?: unknown }>
    const names = new Set(columns.map(column => String(column.name ?? '')))
    const missing = ['style', 'room_name'].filter(name => !names.has(name))
    if (missing.length > 0) {
      this.schemaError = new ImessageSchemaError(
        'iMessage chat.db schema is not compatible with this channel: '
        + `missing column(s) ${missing.map(name => `chat.${name}`).join(', ')}. `
        + 'Both chat.style and chat.room_name are required to distinguish 1:1 messages from '
        + 'group messages; refusing to guess or treat rows as 1:1.',
      )
      this.schemaChecked = true
      throw this.schemaError
    }
    this.schemaChecked = true
  }

  close(): void {
    this.db?.close()
    this.db = undefined
  }

  async maxRowId(): Promise<number> {
    const row = this.open().prepare('SELECT MAX(ROWID) AS maxId FROM message').get() as
      | { maxId: number | null }
      | undefined
    return Number(row?.maxId ?? 0) || 0
  }

  async pull(afterRowId: number, opts: ImessagePullOptions = {}): Promise<ImessageInbound[]> {
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 200)
    const db = this.open()
    this.ensureChatSchema(db)
    // Skip rows with no text payload at all (tapbacks, pure attachments) in
    // SQL so they cannot occupy the page and stall the ROWID cursor. Page by
    // message ROWID, not by joined row: every chat of a selected message is
    // returned so groupness can be aggregated over all of its joins.
    const innerWhere = [
      'm2.ROWID > ?',
      'm2.is_from_me = 0',
      '(m2.text IS NOT NULL AND m2.text <> \'\' OR m2.attributedBody IS NOT NULL)',
    ]
    const params: Array<number | string> = [afterRowId]
    if (opts.handle) {
      innerWhere.push('h2.id = ?')
      params.push(opts.handle)
    }
    if (opts.chatGuid) {
      // Match the message through any of its chats, but still join all chats
      // below: restricting the join would hide a group row from the aggregate.
      innerWhere.push(
        'EXISTS (SELECT 1 FROM chat_message_join cmj_filter '
        + 'JOIN chat c_filter ON c_filter.ROWID = cmj_filter.chat_id '
        + 'WHERE cmj_filter.message_id = m2.ROWID AND c_filter.guid = ?)',
      )
      params.push(opts.chatGuid)
    }
    params.push(limit)
    const sql = `
      SELECT m.ROWID AS rowId, m.guid AS guid, m.text AS text, m.attributedBody AS attributedBody,
             m.date AS date, m.service AS service,
             h.id AS handle, c.ROWID AS chatRowId,
             c.guid AS chatGuid, c.chat_identifier AS chatIdentifier,
             c.style AS chatStyle, c.room_name AS roomName
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN chat c ON c.ROWID = cmj.chat_id
      WHERE m.ROWID IN (
        SELECT m2.ROWID
        FROM message m2
        LEFT JOIN handle h2 ON m2.handle_id = h2.ROWID
        WHERE ${innerWhere.join(' AND ')}
        ORDER BY m2.ROWID ASC
        LIMIT ?
      )
      ORDER BY m.ROWID ASC, c.ROWID ASC`
    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>

    interface Aggregate {
      row: Record<string, unknown>
      groupSignal: boolean
      chatRows: number
      directRows: number
      firstChatGuid?: string
      firstChatIdentifier?: string
      groupChatGuid?: string
      groupChatIdentifier?: string
      groupChatRowId?: number
    }
    // One message can join multiple chats. Aggregate every joined row first;
    // taking the first row's chat metadata loses groupness when the 1:1 join
    // happens to sort first.
    const aggregates = new Map<string, Aggregate>()
    for (const row of rows) {
      const guid = String(row.guid ?? `row_${String(row.rowId)}`)
      let aggregate = aggregates.get(guid)
      if (!aggregate) {
        aggregate = { row, groupSignal: false, chatRows: 0, directRows: 0 }
        aggregates.set(guid, aggregate)
      }
      const chatGuid = nonEmptyText(row.chatGuid)
      const chatIdentifier = nonEmptyText(row.chatIdentifier)
      const style = row.chatStyle == null ? undefined : Number(row.chatStyle)
      const roomName = nonEmptyText(row.roomName)
      const hasChatRow = chatGuid !== undefined || chatIdentifier !== undefined
      if (hasChatRow) {
        aggregate.chatRows += 1
        if (aggregate.firstChatGuid === undefined && aggregate.firstChatIdentifier === undefined) {
          aggregate.firstChatGuid = chatGuid
          aggregate.firstChatIdentifier = chatIdentifier
        }
      }
      // A positive group signal wins. `style = 43` or a non-empty room name
      // marks a group; a chat row with any other style (or no style at all) is
      // ambiguous and therefore treated as a group too.
      if (style === IMESSAGE_GROUP_CHAT_STYLE || roomName !== undefined) {
        aggregate.groupSignal = true
        // Aggregate the group guid, identifier, and ROWID independently: the
        // first usable value of each wins, so an identifier-only positive row
        // cannot hide a usable guid from a later positive row. The ROWID is
        // taken only from a positive group row — never from a joined 1:1 or
        // ambiguous chat — and only when it is a safe positive integer.
        if (aggregate.groupChatGuid === undefined && chatGuid !== undefined) {
          aggregate.groupChatGuid = chatGuid
        }
        if (aggregate.groupChatIdentifier === undefined && chatIdentifier !== undefined) {
          aggregate.groupChatIdentifier = chatIdentifier
        }
        if (aggregate.groupChatRowId === undefined) {
          aggregate.groupChatRowId = safeChatRowId(row.chatRowId)
        }
      }
      if (hasChatRow && style === IMESSAGE_DIRECT_CHAT_STYLE && roomName === undefined) {
        aggregate.directRows += 1
      }
    }

    const out: ImessageInbound[] = []
    for (const aggregate of aggregates.values()) {
      const { row } = aggregate
      // Direct only when every joined chat row is a known 1:1 chat. No chat
      // row, a group row, or any ambiguous metadata fails closed as a group.
      const isGroup = aggregate.groupSignal
        || aggregate.chatRows === 0
        || aggregate.directRows !== aggregate.chatRows
      // A group address comes only from a positive group row (`style = 43` or
      // a non-empty room name). Never fall back to another joined chat's guid:
      // an ambiguous group joined to a 1:1 chat must fail closed, not reply to
      // that direct conversation.
      const chatGuid = isGroup
        ? aggregate.groupChatGuid
        : aggregate.firstChatGuid
      const chatIdentifier = isGroup
        ? aggregate.groupChatIdentifier
        : aggregate.firstChatIdentifier
      // ROWID is a group-only fallback identity: a 1:1 row never contributes
      // one, so 1:1 threads stay keyed by `handle:`.
      const chatRowId = isGroup ? aggregate.groupChatRowId : undefined
      const body = row.text != null && String(row.text).length > 0
        ? String(row.text)
        : decodeAttributedBody(row.attributedBody)
      // Keep empty decodes so the caller's cursor advances past them; the
      // source filters them out of the Trigger list.
      out.push({
        rowId: Number(row.rowId),
        guid: String(row.guid ?? `row_${String(row.rowId)}`),
        text: body,
        handle: String(row.handle ?? aggregate.firstChatIdentifier ?? chatIdentifier ?? 'unknown'),
        ...(row.service ? { service: String(row.service) } : {}),
        ...(chatGuid ? { chatGuid } : {}),
        ...(chatIdentifier ? { chatIdentifier } : {}),
        ...(chatRowId !== undefined ? { chatRowId } : {}),
        isGroup,
        at: appleDateToIso(row.date),
      })
    }
    return out
  }

  async send(target: ImessageTarget, text: string): Promise<{ externalId: string }> {
    const mode = target.chatGuid ? 'chat' : 'buddy'
    const value = target.chatGuid ?? target.handle
    if (!value) throw new Error('imessage send needs a handle or chatGuid')
    const externalId = nextExternalId()
    await this.run(APPLE_SEND_SCRIPT, {
      ...process.env,
      DS_AGENT_IMSG_TEXT: text,
      DS_AGENT_IMSG_TARGET: value,
      DS_AGENT_IMSG_MODE: mode,
      DS_AGENT_IMSG_EXTERNAL_ID: externalId,
    })
    return { externalId }
  }
}

/** Posts a Router outbox row back into the same iMessage conversation. */
export class ImessageOutboxAdapter implements OutboundAdapter {
  readonly channel = 'imessage'

  constructor(
    private readonly api: Pick<ImessageApi, 'send'>,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  async send(row: OutboxRow): Promise<{ externalId: string }> {
    const handle = row.target.handle
    const chatGuid = row.target.chatGuid
    const group = row.target.group
    // A group-originated row may only be delivered with its group chat guid.
    // Sending its sender `handle` would use buddy (1:1) mode and leak group
    // content into a direct conversation, so refuse instead of falling back.
    if (group && !chatGuid) {
      throw new PermanentDeliveryError(
        `imessage outbox row ${row.id} targets group ${group} without a chatGuid; `
        + 'refusing to fall back to a buddy (1:1) send',
      )
    }
    if (!handle && !chatGuid) {
      throw new Error(`imessage outbox row ${row.id} has no target.handle or target.chatGuid`)
    }
    const result = await this.api.send(chatGuid ? { chatGuid } : { handle }, row.text)
    this.log(`[imessage] outbound row=${row.id} target=${chatGuid ?? handle} externalId=${result.externalId}`)
    return result
  }
}

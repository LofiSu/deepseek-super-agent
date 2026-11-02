import { spawn } from 'node:child_process'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { OutboundAdapter } from './outbox-adapter.ts'
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

export function imessageThreadFor(message: { handle: string; chatGuid?: string }): string {
  return message.chatGuid ? `chat:${message.chatGuid}` : `handle:${message.handle}`
}

/** Map a real inbound message to a Trigger. A dedicated agent account is addressed directly. */
export function imessageTrigger(message: ImessageInbound): Trigger {
  const thread = imessageThreadFor(message)
  return {
    id: `imessage_${message.guid}`,
    source: 'imessage',
    threads: [{ source: 'imessage', id: thread }],
    actor: { source: 'imessage', id: message.handle },
    human: true,
    addressed: 'direct',
    at: message.at,
    text: message.text,
    channel: {
      source: 'imessage',
      thread,
      address: {
        provider: 'imessage',
        handle: message.handle,
        ...(message.chatGuid ? { chatGuid: message.chatGuid } : {}),
      },
    },
    meta: {},
  }
}

/** Pulls new inbound messages and maps them to Triggers, advancing the ROWID cursor. */
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
    return { messages, triggers: messages.map(imessageTrigger), lastRowId }
  }
}

export type OsascriptRunner = (script: string, env: NodeJS.ProcessEnv) => Promise<string>

/** Production runner: spawn `osascript` with the script on argv and text/target through env. */
export const runOsascript: OsascriptRunner = (script, env) => new Promise((resolve, reject) => {
  const child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'], env })
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
    const where = ['m.ROWID > ?', 'm.is_from_me = 0']
    const params: Array<number | string> = [afterRowId]
    if (opts.handle) {
      where.push('h.id = ?')
      params.push(opts.handle)
    }
    if (opts.chatGuid) {
      where.push('c.guid = ?')
      params.push(opts.chatGuid)
    }
    params.push(limit)
    // One message can join multiple chats; dedupe by guid below.
    const sql = `
      SELECT m.ROWID AS rowId, m.guid AS guid, m.text AS text, m.attributedBody AS attributedBody,
             m.date AS date, m.service AS service,
             h.id AS handle, c.guid AS chatGuid, c.chat_identifier AS chatIdentifier
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN chat c ON c.ROWID = cmj.chat_id
      WHERE ${where.join(' AND ')}
      ORDER BY m.ROWID ASC
      LIMIT ?`
    const rows = this.open().prepare(sql).all(...params) as Array<Record<string, unknown>>
    const seen = new Set<string>()
    const out: ImessageInbound[] = []
    for (const row of rows) {
      const guid = String(row.guid ?? `row_${String(row.rowId)}`)
      if (seen.has(guid)) continue
      seen.add(guid)
      const body = row.text != null && String(row.text).length > 0
        ? String(row.text)
        : decodeAttributedBody(row.attributedBody)
      if (!body.trim()) continue
      out.push({
        rowId: Number(row.rowId),
        guid,
        text: body,
        handle: String(row.handle ?? row.chatIdentifier ?? 'unknown'),
        ...(row.service ? { service: String(row.service) } : {}),
        ...(row.chatGuid ? { chatGuid: String(row.chatGuid) } : {}),
        ...(row.chatIdentifier ? { chatIdentifier: String(row.chatIdentifier) } : {}),
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
    if (!handle && !chatGuid) {
      throw new Error(`imessage outbox row ${row.id} has no target.handle or target.chatGuid`)
    }
    const result = await this.api.send(chatGuid ? { chatGuid } : { handle }, row.text)
    this.log(`[imessage] outbound row=${row.id} target=${chatGuid ?? handle} externalId=${result.externalId}`)
    return result
  }
}

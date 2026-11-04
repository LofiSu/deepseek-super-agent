/**
 * Channel integration for `serve` plus the offline `channels check` preflight.
 *
 * The preflight never constructs a Runtime or a model, never opens SQLite,
 * never sends an iMessage/Feishu message, and (without `--network`) never
 * touches the network. It reports only presence/readiness; app secrets and
 * message text are never printed.
 */

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FeishuClient, FeishuOutboxAdapter, FeishuSource, type FeishuConfig } from '../channels/feishu.ts'
import {
  ChatDbImessageApi,
  ImessageOutboxAdapter,
  ImessageSource,
  IMESSAGE_AUTOMATION_COMMAND,
  IMESSAGE_AUTOMATION_HINT,
  IMESSAGE_FULL_DISK_ACCESS_HINT,
  imessageDbPath,
  isImessagePermissionError,
  type ImessageApi,
} from '../channels/imessage.ts'
import type { OutboundAdapter } from '../channels/outbox-adapter.ts'
import type { Runtime } from '../runtime.ts'
import { runImessageLoop, type ImessageLoopOptions } from './channel-loop.ts'
import { resolveFeishuCliConfig, runFeishuLoop, type FeishuCliConfig, type FeishuLoopOptions } from './feishu.ts'
import { resolveImessageCliConfig, type ImessageCliConfig } from './imessage.ts'

export type ChannelName = 'imessage' | 'feishu'

export interface ServeChannelConfigs {
  imessage?: ImessageCliConfig
  feishu?: FeishuCliConfig
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  const value = argv[index + 1]?.trim()
  return value && !value.startsWith('--') ? value : undefined
}

/**
 * Resolve both opt-in serve channels before `Runtime.create`. With both flags,
 * collect errors from both so an operator fixes one round of configuration,
 * not one error at a time. A single channel keeps its historical error text.
 */
export function resolveServeChannelConfigs(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): ServeChannelConfigs {
  const wantsImessage = argv.includes('--imessage')
  const wantsFeishu = argv.includes('--feishu')
  if (!wantsImessage && !wantsFeishu) return {}

  if (wantsImessage && wantsFeishu) {
    const errors: string[] = []
    let imessage: ImessageCliConfig | undefined
    let feishu: FeishuCliConfig | undefined
    try {
      imessage = resolveImessageCliConfig(argv, env)
      if (!imessage.admission.allowed) {
        errors.push(`iMessage: ${imessage.admission.error}`)
        imessage = undefined
      }
    } catch (error) {
      errors.push(`iMessage: ${messageOf(error)}`)
    }
    try {
      feishu = resolveFeishuCliConfig(argv, env)
    } catch (error) {
      errors.push(`Feishu: ${messageOf(error)}`)
    }
    if (errors.length > 0 || !imessage || !feishu) {
      throw new Error(
        'cannot start both inbound channels; fix every item below before SQLite, chat.db, or Feishu '
        + `network access is opened:\n${errors.map(line => `- ${line}`).join('\n')}`,
      )
    }
    return { imessage, feishu }
  }

  if (wantsImessage) {
    const imessage = resolveImessageCliConfig(argv, env)
    if (!imessage.admission.allowed) throw new Error(imessage.admission.error)
    return { imessage }
  }
  return { feishu: resolveFeishuCliConfig(argv, env) }
}

export interface ImessageApiHandle extends ImessageApi {
  close(): void
}

export type ImessageLoopRunner = (options: ImessageLoopOptions) => Promise<unknown>
export type FeishuLoopRunner = (options: FeishuLoopOptions) => Promise<unknown>

export interface StartServeChannelsOptions {
  runtime: Runtime
  imessage?: ImessageCliConfig
  feishu?: FeishuCliConfig
  /** Test seam; production constructs the real read-only chat.db API. */
  createImessageApi?: (dbPath: string) => ImessageApiHandle
  /** Test seam; production constructs the real Feishu client. */
  createFeishuClient?: (config: FeishuConfig) => FeishuClient
  runImessage?: ImessageLoopRunner
  runFeishu?: FeishuLoopRunner
}

export interface StartedServeChannels {
  /** Abort both inbound loops. Each loop owns its own controller. */
  abort(): void
  /** Resolves after both loops have stopped, whether they succeeded or failed. */
  wait(): Promise<void>
  /** Close the iMessage SQLite handle. Call only after `wait()`. */
  close(): void
}

/**
 * Start every configured inbound loop over one Runtime. A loop failure is
 * logged and swallowed by that loop's guarded promise, so it cannot reject
 * shutdown or stop the other loop/daemon.
 */
export function startServeChannels(options: StartServeChannelsOptions): StartedServeChannels {
  const { runtime, imessage, feishu } = options
  if (imessage && !imessage.admission.allowed) throw new Error(imessage.admission.error)
  const log = (line: string): void => runtime.log.info(line)
  const imessageAbort = imessage ? new AbortController() : undefined
  const feishuAbort = feishu ? new AbortController() : undefined
  const adapters: OutboundAdapter[] = []
  let imessageApi: ImessageApiHandle | undefined
  let feishuClient: FeishuClient | undefined

  if (imessage) {
    imessageApi = (options.createImessageApi ?? (dbPath => new ChatDbImessageApi(dbPath)))(imessage.dbPath)
    adapters.push(new ImessageOutboxAdapter(imessageApi, log))
  }
  if (feishu) {
    feishuClient = (options.createFeishuClient ?? (config => new FeishuClient(config)))(feishu.config)
    adapters.push(new FeishuOutboxAdapter(feishuClient, log))
  }

  const tasks: Promise<void>[] = []
  const guard = (name: ChannelName, start: () => Promise<unknown>): void => {
    let running: Promise<unknown>
    try {
      // Invoke immediately (not in a microtask) so both outboxes finish their
      // startup `requeueSending()` pass before either can flush.
      running = start()
    } catch (error) {
      log(`[${name}] loop stopped error=${messageOf(error)}`)
      return
    }
    tasks.push(running.then(
      () => undefined,
      error => { log(`[${name}] loop stopped error=${messageOf(error)}`) },
    ))
  }

  if (imessage && imessageApi && imessageAbort) {
    const api = imessageApi
    guard('imessage', () => (options.runImessage ?? runImessageLoop)({
      runtime,
      source: new ImessageSource(api, {
        ...(imessage.handle ? { handle: imessage.handle } : {}),
        allowGroups: imessage.allowGroups,
      }),
      api,
      outboxAdapters: adapters,
      dbPath: imessage.dbPath,
      handle: imessage.handle,
      allowGroups: imessage.allowGroups,
      allowAny: imessage.allowAny,
      intervalMs: imessage.intervalMs,
      since: imessage.since,
      once: imessage.once,
      signal: imessageAbort.signal,
      // A bad/unavailable chat.db must not kill the daemon; the loop retries
      // schema/transient errors with bounded backoff. Permission denials remain
      // terminal and carry the Full Disk Access hint.
      retrySchemaErrors: true,
    }))
  }
  if (feishu && feishuClient && feishuAbort) {
    const client = feishuClient
    guard('feishu', () => (options.runFeishu ?? runFeishuLoop)({
      runtime,
      chatId: feishu.chatId,
      client,
      outboxAdapters: adapters,
      createSource: sinceMs => new FeishuSource(client, feishu.chatId, {
        ...(sinceMs !== undefined ? { sinceMs } : {}),
        config: feishu.config,
      }),
      intervalMs: feishu.intervalMs,
      since: feishu.since,
      once: feishu.once,
      signal: feishuAbort.signal,
    }))
  }

  return {
    abort() {
      imessageAbort?.abort()
      feishuAbort?.abort()
    },
    wait() {
      return Promise.all(tasks).then(() => undefined)
    },
    close() {
      imessageApi?.close()
    },
  }
}

/** Resolve an executable from PATH without spawning it (no prompt, no side effect). */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // Keep looking.
    }
  }
  return undefined
}

/** Columns the production iMessage queries read. ROWID is implicit. */
const IMESSAGE_REQUIRED_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  message: ['guid', 'text', 'attributedBody', 'date', 'service', 'handle_id', 'is_from_me'],
  handle: ['id'],
  chat: ['guid', 'chat_identifier', 'style', 'room_name'],
  chat_message_join: ['chat_id', 'message_id'],
}

export interface ImessageDatabaseInspection {
  missing: string[]
  messageCount?: number
  latestRowId?: number
}

/**
 * Inspect chat.db read-only. Only schema metadata and `COUNT`/`MAX(ROWID)` are
 * read; no message text is selected. The `open` seam lets tests simulate a TCC
 * denial on a platform that cannot reproduce macOS Full Disk Access.
 */
export function inspectImessageDatabase(
  dbPath: string,
  open: (dbPath: string) => DatabaseSync = file => new DatabaseSync(file, { readOnly: true }),
): ImessageDatabaseInspection {
  const db = open(dbPath)
  try {
    const missing: string[] = []
    for (const [table, required] of Object.entries(IMESSAGE_REQUIRED_SCHEMA)) {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>
      const columns = new Set(rows.map(row => String(row.name ?? '')))
      if (columns.size === 0) {
        missing.push(`${table} (table missing)`)
        continue
      }
      for (const column of required) {
        if (!columns.has(column)) missing.push(`${table}.${column}`)
      }
    }
    if (missing.length > 0) return { missing }
    const row = db.prepare('SELECT COUNT(*) AS count, MAX(ROWID) AS latest FROM message').get() as
      | { count?: unknown; latest?: unknown }
      | undefined
    return {
      missing,
      messageCount: Number(row?.count ?? 0),
      latestRowId: Number(row?.latest ?? 0),
    }
  } finally {
    db.close()
  }
}

export interface ChannelCheckResult {
  channel: ChannelName
  ready: boolean
  lines: string[]
}

export interface CheckInput {
  argv?: string[]
  env?: NodeJS.ProcessEnv
}

export interface ImessageCheckOptions extends CheckInput {
  /** Test seam for a simulated TCC denial. */
  openDatabase?: (dbPath: string) => DatabaseSync
  /** Test seam and platform guard; defaults to a PATH lookup for `osascript`. */
  findExecutable?: (name: string, env: NodeJS.ProcessEnv) => string | undefined
}

function imessageAdmissionLine(config: ImessageCliConfig): string {
  return `[imessage] admission: allowed handle=${config.handle ?? '(none)'} `
    + `allow-any=${config.allowAny ? 'yes' : 'no'} allow-groups=${config.allowGroups ? 'yes' : 'no'} `
    + `configured-senders=${config.admission.senders.length}`
}

/**
 * Offline iMessage preflight. It opens chat.db read-only and reports metadata,
 * admission, and osascript presence. It never runs AppleScript, so the default
 * check cannot prompt for Automation and cannot send a message.
 */
export function checkImessageChannel(options: ImessageCheckOptions = {}): ChannelCheckResult {
  const env = options.env ?? process.env
  const argv = options.argv ?? process.argv
  const lines: string[] = []
  let ready = true
  const fail = (line: string): void => {
    ready = false
    lines.push(`[imessage] ${line}`)
  }

  let config: ImessageCliConfig | undefined
  try {
    config = resolveImessageCliConfig(argv, env)
  } catch (error) {
    fail(`config: FAILED ${messageOf(error)}`)
  }
  if (config && !config.admission.allowed) {
    lines.push(
      `[imessage] admission: denied handle=${config.handle ?? '(none)'} `
      + `allow-any=${config.allowAny ? 'yes' : 'no'} allow-groups=${config.allowGroups ? 'yes' : 'no'}`,
    )
    fail(config.admission.error ?? 'iMessage channel refused its admission configuration')
  } else if (config) {
    lines.push(imessageAdmissionLine(config))
  }

  const dbPath = config?.dbPath ?? flagValue(argv, 'db') ?? imessageDbPath(env)
  lines.push(`[imessage] database: ${dbPath}`)
  if (!fs.existsSync(dbPath)) {
    fail(`database: not found at ${dbPath}; set DS_AGENT_IMESSAGE_DB or pass --db <path>`)
  } else {
    try {
      const inspection = inspectImessageDatabase(dbPath, options.openDatabase)
      if (inspection.missing.length > 0) {
        fail(
          'schema: incompatible; missing '
          + `${inspection.missing.join(', ')}. Both chat.style and chat.room_name are required to `
          + 'distinguish 1:1 from group chats.',
        )
      } else {
        lines.push('[imessage] schema: ok (required message/handle/chat/join columns present)')
        lines.push(
          `[imessage] messages: count=${inspection.messageCount ?? 0} `
          + `latest_rowid=${inspection.latestRowId ?? 0} (metadata only; text not read)`,
        )
      }
    } catch (error) {
      const detail = messageOf(error)
      if (isImessagePermissionError(error)) {
        fail(
          `database: permission denied — ${detail.includes('Full Disk Access')
            ? detail
            : `${detail}. ${IMESSAGE_FULL_DISK_ACCESS_HINT}`}`,
        )
      } else {
        fail(`database: unreadable — ${detail}`)
      }
    }
  }

  const executable = (options.findExecutable ?? findExecutable)('osascript', env)
  if (executable) lines.push(`[imessage] osascript: found (${executable})`)
  else fail('osascript: not found; outbound requires macOS Messages.app and osascript')

  // Never execute this in preflight: it can raise the Automation TCC prompt.
  lines.push('[imessage] manual Automation check (does not send a message; may prompt once):')
  lines.push(`  ${IMESSAGE_AUTOMATION_COMMAND}`)
  lines.push(`  ${IMESSAGE_AUTOMATION_HINT}`)
  lines.push(`[imessage] Full Disk Access (only if chat.db cannot open): ${IMESSAGE_FULL_DISK_ACCESS_HINT}`)
  lines.push(`[imessage] would start: ${ready ? 'yes' : 'no'}`)
  lines.push(`[imessage] ${ready ? 'ready' : 'NOT READY'}`)
  return { channel: 'imessage', ready, lines }
}

export type FeishuFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface FeishuCheckOptions extends CheckInput {
  /** Default false: no network call at all. */
  network?: boolean
  /** Test seam for `--network`; the production path uses fetch with a timeout. */
  fetchImpl?: FeishuFetch
}

function feishuCredentialLine(env: NodeJS.ProcessEnv): string {
  const appId = Boolean(env.FEISHU_APP_ID?.trim())
  const appSecret = Boolean(env.FEISHU_APP_SECRET?.trim())
  if (appId && appSecret) {
    return '[feishu] credentials: present (FEISHU_APP_ID + FEISHU_APP_SECRET paired; values hidden)'
  }
  const missing = [
    ...(!appId ? ['FEISHU_APP_ID'] : []),
    ...(!appSecret ? ['FEISHU_APP_SECRET'] : []),
  ]
  return `[feishu] credentials: missing/incomplete (${missing.join(', ')})`
}

/**
 * Feishu preflight. Default is offline and checks configuration only. With
 * `network: true` it requests a real tenant access token (no message is sent)
 * and reports only success/failure, never the app secret or token value.
 */
export async function checkFeishuChannel(options: FeishuCheckOptions = {}): Promise<ChannelCheckResult> {
  const env = options.env ?? process.env
  const argv = options.argv ?? process.argv
  const lines = [feishuCredentialLine(env)]
  const baseUrl = (env.FEISHU_BASE_URL?.trim() || 'https://open.feishu.cn').replace(/\/$/, '')
  lines.push(`[feishu] base URL: ${baseUrl}`)
  const chatId = flagValue(argv, 'chat') ?? env.FEISHU_CHAT_ID?.trim()
  lines.push(`[feishu] chat: ${chatId ? 'present (polling exactly one chat)' : 'missing'}`)
  lines.push(
    '[feishu] scopes: im:message, im:message:send_as_bot, im:message:readonly, '
    + 'im:message.group_msg (group history); publish an app version after adding them',
  )

  let config: FeishuCliConfig | undefined
  const errorLines: string[] = []
  try {
    config = resolveFeishuCliConfig(argv, env)
  } catch (error) {
    errorLines.push(`[feishu] config: FAILED ${messageOf(error)}`)
  }

  let ready = errorLines.length === 0
  if (!options.network) {
    lines.push('[feishu] network: skipped (offline check; pass --network for a real tenant_access_token call)')
  } else if (!config) {
    lines.push('[feishu] network: skipped (configuration is not ready)')
  } else {
    const fetchImpl: FeishuFetch = options.fetchImpl ?? ((input, init) => fetch(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(15_000),
    }))
    try {
      const client = new FeishuClient(config.config, fetchImpl)
      await client.accessToken()
      lines.push('[feishu] tenant_access_token: ok (no message sent)')
    } catch (error) {
      ready = false
      lines.push(`[feishu] tenant_access_token: FAILED ${messageOf(error)}`)
    }
  }

  lines.push(...errorLines)
  lines.push(`[feishu] would start: ${ready ? 'yes' : 'no'}`)
  lines.push(`[feishu] ${ready ? 'ready' : 'NOT READY'}`)
  return { channel: 'feishu', ready, lines }
}

/** `--imessage` / `--feishu` select check filters; no filter means both. */
export function selectedCheckChannels(argv: readonly string[] = process.argv): ChannelName[] {
  const channels: ChannelName[] = []
  if (argv.includes('--imessage')) channels.push('imessage')
  if (argv.includes('--feishu')) channels.push('feishu')
  return channels.length > 0 ? channels : ['imessage', 'feishu']
}

export interface ChannelsCheckOptions extends CheckInput {
  channels?: readonly ChannelName[]
  network?: boolean
  fetchImpl?: FeishuFetch
  openDatabase?: (dbPath: string) => DatabaseSync
  findExecutable?: (name: string, env: NodeJS.ProcessEnv) => string | undefined
}

export interface ChannelsCheckReport {
  /** 0 only when every selected channel is ready. */
  code: 0 | 1
  ready: boolean
  results: ChannelCheckResult[]
  lines: string[]
}

/**
 * Run the selected preflights without a model or Runtime. The caller prints
 * `lines` and uses `code` as the process exit status.
 */
export async function runChannelsCheck(options: ChannelsCheckOptions = {}): Promise<ChannelsCheckReport> {
  const env = options.env ?? process.env
  const argv = options.argv ?? process.argv
  const channels = options.channels ?? selectedCheckChannels(argv)
  const results: ChannelCheckResult[] = []
  for (const channel of channels) {
    if (channel === 'imessage') {
      results.push(checkImessageChannel({
        argv,
        env,
        ...(options.openDatabase ? { openDatabase: options.openDatabase } : {}),
        ...(options.findExecutable ? { findExecutable: options.findExecutable } : {}),
      }))
    } else {
      results.push(await checkFeishuChannel({
        argv,
        env,
        network: options.network === true,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      }))
    }
  }
  const readyCount = results.filter(result => result.ready).length
  const ready = readyCount === results.length
  const lines = [
    ...results.flatMap(result => result.lines),
    '',
    `channels check: ${readyCount}/${results.length} selected channel(s) ready`,
  ]
  if (!ready) {
    lines.push(
      'channels check: NOT READY — fix every [imessage]/[feishu] error above; '
      + 'this command sent no message and did not start the daemon.',
    )
  }
  return { code: ready ? 0 : 1, ready, results, lines }
}

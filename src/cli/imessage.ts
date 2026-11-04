import {
  ChatDbImessageApi,
  DEFAULT_IMESSAGE_INTERVAL_MS,
  ImessageSource,
  decideImessageAdmission,
  imessageDbPath,
  type ImessageAdmissionDecision,
} from '../channels/imessage.ts'
import { requireLiveModelFromEnv } from '../harness/model.ts'
import { Runtime } from '../runtime.ts'
import { runImessageLoop } from './channel-loop.ts'

/**
 * Resolve `--handle` / `DS_AGENT_IMESSAGE_HANDLE` exactly once and trim it.
 * The same value feeds both the startup admission decision and the SQL sender
 * filter; padded input would make the filter match nothing and idle silently.
 * An explicitly passed but missing/flag-like value is rejected, never treated
 * as "no handle".
 */
export function resolveImessageHandle(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const index = argv.indexOf('--handle')
  if (index >= 0) {
    const raw = argv[index + 1]
    const handle = raw?.trim()
    if (!handle || handle.startsWith('--')) {
      throw new Error(
        'iMessage --handle needs a non-empty sender id; '
        + 'a missing value, whitespace, or another flag is not valid.',
      )
    }
    return handle
  }
  const raw = env.DS_AGENT_IMESSAGE_HANDLE
  if (raw === undefined) return undefined
  const handle = raw.trim()
  if (!handle || handle.startsWith('--')) {
    throw new Error(
      'DS_AGENT_IMESSAGE_HANDLE must be a non-empty sender id; '
      + 'whitespace-only or flag-like values are refused.',
    )
  }
  return handle
}

export interface ImessageCliConfig {
  dbPath: string
  handle: string | undefined
  allowAny: boolean
  allowGroups: boolean
  once: boolean
  intervalMs: number
  /** ROWID to replay from; NaN when unset. Only a positive value is used. */
  since: number
  /** Default-deny startup gate, shared with `serve --imessage`. */
  admission: ImessageAdmissionDecision
}

/**
 * Parse `imessage`/`serve --imessage` flags and environment exactly once.
 * `chat` and `serve` both call this so admission and cursor inputs cannot drift.
 * This touches no model, SQLite, or chat.db.
 */
export function resolveImessageCliConfig(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): ImessageCliConfig {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    return index < 0 ? undefined : argv[index + 1]
  }
  const has = (name: string): boolean => argv.includes(`--${name}`)

  const handle = resolveImessageHandle(argv, env)
  const allowAny = has('allow-any') || env.DS_AGENT_IMESSAGE_ALLOW_ANY === '1'
  const allowGroups = has('allow-groups') || env.DS_AGENT_IMESSAGE_ALLOW_GROUPS === '1'
  const admission = decideImessageAdmission({
    handle,
    actorAllowlist: env.DS_AGENT_ACTOR_ALLOWLIST,
    allowAny,
  })
  const intervalMs = Math.max(
    1_000,
    Number(flag('interval') ?? env.DS_AGENT_IMESSAGE_INTERVAL_MS) || DEFAULT_IMESSAGE_INTERVAL_MS,
  )

  return {
    dbPath: flag('db') ?? imessageDbPath(env),
    handle,
    allowAny,
    allowGroups,
    once: has('once'),
    intervalMs,
    since: Number(flag('since') ?? env.DS_AGENT_IMESSAGE_SINCE),
    admission,
  }
}

/**
 * `ds-agent imessage` — a live two-way iMessage channel for a dedicated Apple ID.
 *
 * Reads new inbound messages from chat.db and posts replies back through
 * Messages.app. Requires Full Disk Access (read) + Automation (send) and a
 * live model key. Admission is default-deny: the command refuses to start
 * unless a non-empty `--handle`/`DS_AGENT_IMESSAGE_HANDLE` or
 * `DS_AGENT_ACTOR_ALLOWLIST` names a sender, or `--allow-any` is an explicit
 * opt-out. Group chats are skipped unless `--allow-groups` is passed. On the
 * first run the cursor starts at the current max ROWID, so only messages that
 * arrive from now on are handled; pass `--since <rowid>` to replay from an
 * explicit point.
 *
 * The polling loop itself lives in `channel-loop.ts` so `serve --imessage` can
 * run the same code against the daemon's Runtime.
 */
export async function runImessageCommand(home: string): Promise<void> {
  const config = resolveImessageCliConfig()
  // Fail closed before the model, runtime, or chat.db is touched. Missing
  // configuration must never turn into an implicit "any sender" channel.
  if (!config.admission.allowed) throw new Error(config.admission.error)

  const { dbPath, handle, allowAny, allowGroups } = config

  let model: ReturnType<typeof requireLiveModelFromEnv>
  try {
    model = requireLiveModelFromEnv()
  } catch (error) {
    throw new Error(`iMessage channel needs a live model: ${error instanceof Error ? error.message : String(error)}`)
  }

  const api = new ChatDbImessageApi(dbPath)
  const runtime = Runtime.create({ home, model, jobDelayMs: 20, watchdogIntervalMs: 60_000 })
  runtime.start()
  if (allowAny) {
    runtime.log.info(
      '[imessage] WARNING: --allow-any is active; any sender in a 1:1 chat can trigger work. '
      + 'Prefer --handle or DS_AGENT_ACTOR_ALLOWLIST unless this is intentional.',
    )
  }
  if (allowGroups) {
    runtime.log.info(
      '[imessage] WARNING: --allow-groups is active; group messages are ingested, '
      + 'but they are never marked direct and still pass normal admission.',
    )
  }

  const controller = new AbortController()
  const stop = (): void => {
    runtime.log.info('[imessage] stop requested')
    controller.abort()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  try {
    await runImessageLoop({
      runtime,
      source: new ImessageSource(api, { ...(handle ? { handle } : {}), allowGroups }),
      api,
      dbPath,
      handle,
      allowGroups,
      allowAny,
      intervalMs: config.intervalMs,
      since: config.since,
      once: config.once,
      signal: controller.signal,
    })
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    api.close()
    await runtime.finish()
  }
}

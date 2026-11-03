import {
  ChatDbImessageApi,
  DEFAULT_IMESSAGE_INTERVAL_MS,
  ImessageOutboxAdapter,
  ImessageSchemaError,
  ImessageSource,
  decideImessageAdmission,
  imessageDbPath,
} from '../channels/imessage.ts'
import { Outbox } from '../channels/outbox-adapter.ts'
import { requireLiveModelFromEnv } from '../harness/model.ts'
import { Runtime } from '../runtime.ts'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
 */
export async function runImessageCommand(home: string): Promise<void> {
  const dbPath = flag('db') ?? imessageDbPath()
  const handle = resolveImessageHandle()
  const allowAny = has('allow-any') || process.env.DS_AGENT_IMESSAGE_ALLOW_ANY === '1'
  const allowGroups = has('allow-groups') || process.env.DS_AGENT_IMESSAGE_ALLOW_GROUPS === '1'
  const admission = decideImessageAdmission({
    handle,
    actorAllowlist: process.env.DS_AGENT_ACTOR_ALLOWLIST,
    allowAny,
  })
  // Fail closed before the model, runtime, or chat.db is touched. Missing
  // configuration must never turn into an implicit "any sender" channel.
  if (!admission.allowed) throw new Error(admission.error)

  const once = has('once')
  const intervalMs = Math.max(
    1_000,
    Number(flag('interval') ?? process.env.DS_AGENT_IMESSAGE_INTERVAL_MS) || DEFAULT_IMESSAGE_INTERVAL_MS,
  )
  const sinceRaw = Number(flag('since') ?? process.env.DS_AGENT_IMESSAGE_SINCE)

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
  const outbox = new Outbox(
    runtime.store,
    [new ImessageOutboxAdapter(api, line => runtime.log.info(line))],
    { log: line => runtime.log.info(line) },
  )
  outbox.start(400)

  let stopping = false
  const stop = (): void => {
    stopping = true
    runtime.log.info('[imessage] stop requested')
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  try {
    let cursor: number | undefined
    for (;;) {
      const source = new ImessageSource(api, { ...(handle ? { handle } : {}), allowGroups })
      try {
        if (cursor === undefined) {
          const stored = runtime.store.getDoc<{ rowId: number }>('imessage_cursor', 'cursor')
          cursor = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : stored?.rowId ?? (await api.maxRowId())
          runtime.log.info(
            `[imessage] connected db=${dbPath} handle=${handle ?? 'any'} groups=${allowGroups ? 'allowed' : 'closed'} `
            + `cursor=${cursor} intervalMs=${intervalMs} once=${once} allowAny=${allowAny}`,
          )
        }
        const from = cursor
        const pulled = await source.pull(from)
        for (const trigger of pulled.triggers) {
          const preview = trigger.text.replace(/\s+/g, ' ').slice(0, 80)
          runtime.log.info(`[imessage] inbound id=${trigger.id} from=${trigger.actor.id} text=${preview}`)
          try {
            runtime.ingest(trigger)
          } catch (error) {
            runtime.log.info(`[imessage] ingest failed ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (pulled.lastRowId > from) {
          cursor = pulled.lastRowId
          runtime.store.putDoc('imessage_cursor', 'cursor', { rowId: cursor })
        }
        await runtime.jobsSettled().catch(error => {
          runtime.log.info(`[imessage] settle error ${error instanceof Error ? error.message : String(error)}`)
        })
        await outbox.flush().catch(error => {
          runtime.log.info(`[imessage] outbox error ${error instanceof Error ? error.message : String(error)}`)
        })
      } catch (error) {
        // A schema/configuration incompatibility cannot heal between polls:
        // surface it once and stop instead of logging the same failure forever.
        if (error instanceof ImessageSchemaError) throw error
        runtime.log.info(`[imessage] poll error ${error instanceof Error ? error.message : String(error)}`)
      }
      if (once || stopping) break
      await sleep(intervalMs)
    }
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    outbox.stop()
    try {
      await outbox.flush()
    } catch {
      // Best-effort drain on shutdown.
    }
    api.close()
    await runtime.finish()
  }
}

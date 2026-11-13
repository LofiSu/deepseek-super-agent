/**
 * Opt-in inbound Feishu poll loop for `ds-agent serve --feishu`.
 *
 * Configuration is resolved before `Runtime.create` so a missing app
 * credential or chat id fails before SQLite is opened and before any Feishu
 * network call. The loop mirrors `channel-loop.ts` (the shared iMessage loop):
 * pull, ingest, advance the durable cursor, drain jobs, flush the outbox, then
 * sleep abortably. It never closes the Runtime; the caller owns it.
 */

import {
  FeishuOutboxAdapter,
  feishuConfigFromEnv,
  type FeishuClient,
  type FeishuConfig,
} from '../channels/feishu.ts'
import { Outbox, type OutboundAdapter } from '../channels/outbox-adapter.ts'
import {
  ingestResidentTrigger,
  ResidentIngressAbortedError,
  ResidentIngressRejectedError,
  residentIngressLimitFromEnv,
} from './channel-resident-gate.ts'
import type { Runtime } from '../runtime.ts'
import type { Trigger } from '../shared/types.ts'

export const DEFAULT_FEISHU_INTERVAL_MS = 2_000

/** Durable cursor document. One row, keyed by `cursor`. */
const CURSOR_KIND = 'feishu_cursor'
const CURSOR_ID = 'cursor'

interface FeishuCursorDoc {
  chatId: string
  lastCreateTimeMs: number
}

export interface FeishuCliConfig {
  config: FeishuConfig
  /** Chat the poll loop reads. `--chat` overrides `FEISHU_CHAT_ID`. */
  chatId: string
  intervalMs: number
  /** Explicit epoch-ms start; NaN when unset. Only positive finite values are used. */
  since: number
  once: boolean
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  return index < 0 ? undefined : argv[index + 1]
}

function has(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`)
}

/**
 * Parse `serve --feishu` flags and environment. This touches no network,
 * SQLite, or model: a caller can validate and refuse before `Runtime.create`.
 *
 * `--chat` (or `FEISHU_CHAT_ID`) is required. `--since` uses epoch
 * milliseconds, matching Feishu `create_time`, and wins over the stored cursor.
 */
export function resolveFeishuCliConfig(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): FeishuCliConfig {
  const config = feishuConfigFromEnv(env)
  if (!config) {
    throw new Error(
      'serve --feishu needs FEISHU_APP_ID and FEISHU_APP_SECRET; '
      + 'refusing to start an inbound Feishu loop without app credentials.',
    )
  }

  let chatId: string
  if (has(argv, 'chat')) {
    const raw = flag(argv, 'chat')?.trim()
    if (!raw || raw.startsWith('--')) {
      throw new Error('Feishu --chat needs a non-empty chat id (for example oc_...); a missing value or another flag is not valid.')
    }
    chatId = raw
  } else {
    const raw = env.FEISHU_CHAT_ID?.trim()
    if (!raw || raw.startsWith('--')) {
      throw new Error('serve --feishu needs a poll target chat: pass --chat <id> or set FEISHU_CHAT_ID.')
    }
    chatId = raw
  }

  const intervalMs = Math.max(
    1_000,
    Number(flag(argv, 'interval') ?? env.FEISHU_INTERVAL_MS) || DEFAULT_FEISHU_INTERVAL_MS,
  )

  return {
    config: { ...config, chatId },
    chatId,
    intervalMs,
    since: Number(flag(argv, 'since') ?? env.FEISHU_SINCE),
    once: has(argv, 'once'),
  }
}

/** The pull surface `FeishuSource` implements; tests may inject a fake. */
export interface FeishuLoopSource {
  pull(): Promise<readonly Trigger[]>
  /** Highest `create_time` (ms) observed so far, or the seed when none was seen. */
  readonly cursorMs: number
  /** Reset the pull cursor after a blocked ingress window so the next pull replays it. */
  restoreCursor(cursorMs: number): void
}

export interface FeishuLoopOptions {
  /** Runtime that ingests triggers and owns the cursor store. */
  runtime: Runtime
  chatId: string
  /** API used by the outbox adapter to send replies. */
  client: FeishuClient
  /**
   * Outbound adapters for this loop's Outbox. A combined serve passes both
   * channel adapters to both loops: `Outbox.flush()` scans every due row, so a
   * loop with only its own adapter would mark the other channel's rows failed.
   * Defaults to this loop's Feishu adapter.
   */
  outboxAdapters?: readonly OutboundAdapter[]
  /**
   * Build the source with the resolved seed: explicit `--since`, the stored
   * cursor for this chat, or `undefined` to use FeishuSource's now-5min default.
   */
  createSource: (sinceMs: number | undefined) => FeishuLoopSource
  /** Poll interval between successful pulls. Default 2000ms. */
  intervalMs?: number
  /** Positive epoch-ms start; overrides the stored cursor. */
  since?: number
  /** Run exactly one poll, then return. */
  once?: boolean
  /** Aborting stops the loop after the in-flight poll and its drain. */
  signal?: AbortSignal
  /** Upper bound for the exponential retry delay after a failed poll. */
  maxBackoffMs?: number
  /** Max wait when ingress is saturated before rejecting (default 60s). */
  saturateWaitMs?: number
}

export type FeishuLoopStopReason = 'once' | 'aborted'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Sleep that resolves immediately when aborted; clears its timer on abort. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

function storedCursor(runtime: Runtime, chatId: string): number | undefined {
  const doc = runtime.store.getDoc<FeishuCursorDoc>(CURSOR_KIND, CURSOR_ID)
  if (!doc || doc.chatId !== chatId) return undefined
  return Number.isFinite(doc.lastCreateTimeMs) ? doc.lastCreateTimeMs : undefined
}

/**
 * Poll Feishu, ingest new Triggers, persist the durable cursor, drain jobs, and
 * flush the outbox until `once` or abort.
 *
 * Cursor semantics: the persisted `{ chatId, lastCreateTimeMs }` is the highest
 * `create_time` the source observed. It is written only after a successful pull
 * and ingest, and only when it advances, so a restart resumes at the same
 * window. `FeishuSource` intentionally queries one second before the cursor to
 * catch same-second messages; any overlap is deduped by Trigger id in
 * `Runtime.ingest`, so an already-processed message is never processed twice.
 *
 * Pull failures are logged and retried with bounded exponential backoff. Ingest
 * failures are logged and skipped. The loop never closes the client or finishes
 * the Runtime: the caller owns those resources.
 */
export async function runFeishuLoop(options: FeishuLoopOptions): Promise<FeishuLoopStopReason> {
  const { runtime, chatId, client, createSource } = options
  const intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_FEISHU_INTERVAL_MS)
  const maxBackoffMs = Math.max(intervalMs, options.maxBackoffMs ?? 30_000)
  const log = (line: string): void => runtime.log.info(line)

  const outbox = new Outbox(
    runtime.store,
    options.outboxAdapters ?? [new FeishuOutboxAdapter(client, log)],
    { log },
  )
  outbox.start(400)

  const aborted = (): boolean => options.signal?.aborted === true
  const ingressLimit = residentIngressLimitFromEnv(process.env)
  const explicitSince = typeof options.since === 'number'
    && Number.isFinite(options.since)
    && options.since > 0
    ? options.since
    : undefined
  const seeded = explicitSince ?? storedCursor(runtime, chatId)
  const source = createSource(seeded)
  let cursor = seeded
  let reason: FeishuLoopStopReason = 'aborted'
  let failures = 0

  try {
    log(
      `[feishu] connected chat=${chatId} cursor=${cursor ?? 'source-default'} `
      + `intervalMs=${intervalMs} once=${options.once === true}`,
    )
    for (;;) {
      if (aborted()) break
      try {
        // Remember where this pull started. `FeishuSource.pull` advances its
        // in-memory cursor while walking the batch, before the loop ingests
        // anything; a blocked trigger must not be skipped on the next poll.
        const cursorBeforePull = source.cursorMs
        const triggers = await source.pull()
        let cursorBlockedByIngress = false
        for (const trigger of triggers) {
          const preview = trigger.text.replace(/\s+/g, ' ').slice(0, 80)
          log(`[feishu] inbound id=${trigger.id} from=${trigger.actor.id} text=${preview}`)
          try {
            await ingestResidentTrigger(runtime, trigger, {
              limit: ingressLimit,
              signal: options.signal,
              log,
              channel: 'feishu',
              ...(options.saturateWaitMs === undefined ? {} : { saturateWaitMs: options.saturateWaitMs }),
            })
          } catch (error) {
            log(`[feishu] ingest failed ${messageOf(error)}`)
            if (
              error instanceof ResidentIngressRejectedError
              || error instanceof ResidentIngressAbortedError
            ) {
              cursorBlockedByIngress = true
              break
            }
          }
        }
        // Persist only after the pulled triggers were ingested, matching the
        // iMessage loop: a crashed ingest window is retried on the next pull.
        // On a blocked window also roll the source back to where this pull
        // started, so the next pull re-reads the whole uningested span rather
        // than only the source's one-second overlap. Already-ingested ids are
        // deduped by `Runtime.ingest`, so replaying them is safe.
        if (cursorBlockedByIngress) {
          source.restoreCursor(cursorBeforePull)
        } else {
          const advanced = source.cursorMs
          if (
            Number.isFinite(advanced)
            && advanced > 0
            && (cursor === undefined || advanced > cursor)
          ) {
            cursor = advanced
            runtime.store.putDoc(CURSOR_KIND, CURSOR_ID, {
              chatId,
              lastCreateTimeMs: cursor,
            } satisfies FeishuCursorDoc)
          }
        }
        await runtime.jobsSettled().catch(error => {
          log(`[feishu] settle error ${messageOf(error)}`)
        })
        await outbox.flush().catch(error => {
          log(`[feishu] outbox error ${messageOf(error)}`)
        })
        // A successful poll clears the retry backoff.
        failures = 0
      } catch (error) {
        failures += 1
        log(`[feishu] poll error ${messageOf(error)}`)
      }
      if (options.once === true) {
        reason = 'once'
        break
      }
      if (aborted()) break
      const delay = failures === 0
        ? intervalMs
        : Math.min(intervalMs * 2 ** Math.min(failures, 8), maxBackoffMs)
      await sleep(delay, options.signal)
    }
  } finally {
    outbox.stop()
    try {
      await outbox.flush()
    } catch {
      // Best-effort drain on shutdown.
    }
  }
  return reason
}

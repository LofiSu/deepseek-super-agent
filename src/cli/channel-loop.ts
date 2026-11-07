/**
 * Reusable inbound iMessage polling loop.
 *
 * `ds-agent imessage` and `ds-agent serve --imessage` share this loop so the
 * cursor, outbox, and default-deny admission semantics cannot drift. The source,
 * API, and runtime are injectable: `chat` passes a real `ImessageSource` and
 * `Runtime`, while tests pass fakes.
 */

import {
  DEFAULT_IMESSAGE_INTERVAL_MS,
  ImessageOutboxAdapter,
  ImessagePermissionError,
  ImessageSchemaError,
  IMESSAGE_FULL_DISK_ACCESS_HINT,
  isImessagePermissionError,
  type ImessageApi,
} from '../channels/imessage.ts'
import { Outbox, type OutboundAdapter } from '../channels/outbox-adapter.ts'
import { ingestResidentTrigger, ResidentIngressRejectedError, residentIngressLimitFromEnv } from './channel-resident-gate.ts'
import type { Runtime } from '../runtime.ts'
import type { Trigger } from '../shared/types.ts'

/** The pull surface `ImessageSource` implements; tests may inject a fake. */
export interface ImessageLoopSource {
  pull(afterRowId: number): Promise<{
    triggers: readonly Trigger[]
    lastRowId: number
  }>
}

export interface ImessageLoopOptions {
  /** Runtime that ingests triggers and owns the cursor store. */
  runtime: Runtime
  /** Injectable inbound source. */
  source: ImessageLoopSource
  /** API used by the outbox adapter to send replies. */
  api: ImessageApi
  /**
   * Outbound adapters for this loop's Outbox. A combined serve passes both
   * channel adapters to both loops: `Outbox.flush()` scans every due row, so a
   * loop with only its own adapter would mark the other channel's rows failed.
   * Defaults to this loop's iMessage adapter.
   */
  outboxAdapters?: readonly OutboundAdapter[]
  /** chat.db path, for the startup log line only. */
  dbPath: string
  handle?: string
  allowGroups?: boolean
  allowAny?: boolean
  /** Poll interval between successful pulls. Default 2000ms. */
  intervalMs?: number
  /** Positive ROWID to replay from. Non-positive/NaN means seed from SQLite/max. */
  since?: number
  /** Run exactly one poll, then return (the `--once` smoke path). */
  once?: boolean
  /** Aborting stops the loop after the in-flight poll and its drain. */
  signal?: AbortSignal
  /**
   * Retry an `ImessageSchemaError` forever instead of surfacing it once and
   * stopping. `serve` opts in so a bad chat.db cannot kill the daemon; the
   * standalone `imessage` command keeps the fail-fast behavior.
   */
  retrySchemaErrors?: boolean
  /** Upper bound for the exponential retry delay after a failed poll. */
  maxBackoffMs?: number
}

export type ImessageLoopStopReason = 'once' | 'aborted'

/**
 * People text in bursts ("你猜怎么着" / "算了" / "不过..."). Feeding each line
 * to the Router separately produces several half-answers and makes replies look
 * out of order. Merge consecutive 1:1 messages from one sender into a single
 * trigger so the conversation gets one coherent turn.
 */
export function coalesceTriggers(triggers: readonly Trigger[]): Trigger[] {
  const merged: Trigger[] = []
  for (const trigger of triggers) {
    const previous = merged.at(-1)
    if (
      previous
      && trigger.addressed === 'direct'
      && previous.addressed === 'direct'
      && trigger.actor.id === previous.actor.id
      && trigger.channel?.thread === previous.channel?.thread
      && trigger.channel?.address?.group == null
    ) {
      previous.text = `${previous.text}\n${trigger.text}`
      previous.at = trigger.at
      continue
    }
    merged.push({ ...trigger })
  }
  return merged
}

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

/**
 * Poll an inbound source, ingest new Triggers, advance the persisted ROWID
 * cursor, drain jobs, and flush the outbox until `once` or abort.
 *
 * Pull failures are logged and retried with bounded exponential backoff, so a
 * transient chat.db/io error never kills the loop. Ingest failures are logged
 * and skipped. The loop never closes the API or finishes the runtime: the
 * caller owns those resources.
 */
export async function runImessageLoop(options: ImessageLoopOptions): Promise<ImessageLoopStopReason> {
  const { runtime, source, api, dbPath, handle } = options
  const allowGroups = options.allowGroups === true
  const allowAny = options.allowAny === true
  const intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_IMESSAGE_INTERVAL_MS)
  const maxBackoffMs = Math.max(intervalMs, options.maxBackoffMs ?? 30_000)
  const ingressLimit = residentIngressLimitFromEnv(process.env)
  const log = (line: string): void => runtime.log.info(line)

  const outbox = new Outbox(
    runtime.store,
    options.outboxAdapters ?? [new ImessageOutboxAdapter(api, log)],
    { log },
  )
  outbox.start(400)

  const aborted = (): boolean => options.signal?.aborted === true
  let reason: ImessageLoopStopReason = 'aborted'
  let cursor: number | undefined
  let failures = 0

  try {
    for (;;) {
      if (aborted()) break
      try {
        if (cursor === undefined) {
          const stored = runtime.store.getDoc<{ rowId: number }>('imessage_cursor', 'cursor')
          const since = options.since
          cursor = typeof since === 'number' && Number.isFinite(since) && since > 0
            ? since
            : stored?.rowId ?? (await api.maxRowId())
          log(
            `[imessage] connected db=${dbPath} handle=${handle ?? 'any'} groups=${allowGroups ? 'allowed' : 'closed'} `
            + `cursor=${cursor} intervalMs=${intervalMs} once=${options.once === true} allowAny=${allowAny}`,
          )
        }
        const from = cursor
        const pulled = await source.pull(from)
        let cursorBlockedByIngress = false
        for (const trigger of coalesceTriggers(pulled.triggers)) {
          const preview = trigger.text.replace(/\s+/g, ' ').slice(0, 80)
          log(`[imessage] inbound id=${trigger.id} from=${trigger.actor.id} text=${preview}`)
          try {
            await ingestResidentTrigger(runtime, trigger, {
              limit: ingressLimit,
              signal: options.signal,
              log,
              channel: 'imessage',
            })
          } catch (error) {
            log(`[imessage] ingest failed ${messageOf(error)}`)
            if (error instanceof ResidentIngressRejectedError) {
              cursorBlockedByIngress = true
              break
            }
          }
        }
        if (pulled.lastRowId > from && !cursorBlockedByIngress) {
          cursor = pulled.lastRowId
          runtime.store.putDoc('imessage_cursor', 'cursor', { rowId: cursor })
        }
        await runtime.jobsSettled().catch(error => {
          log(`[imessage] settle error ${messageOf(error)}`)
        })
        await outbox.flush().catch(error => {
          log(`[imessage] outbox error ${messageOf(error)}`)
        })
        // A successful poll clears the retry backoff.
        failures = 0
      } catch (error) {
        // Permission denials are not transient. Retrying forever in the
        // standalone command hides the one action that fixes it: grant Full
        // Disk Access and restart the terminal. `serve` logs this terminal
        // loop failure and keeps its other channel and daemon alive.
        if (isImessagePermissionError(error)) {
          const detail = messageOf(error)
          throw detail.includes('Full Disk Access')
            ? error
            : new ImessagePermissionError(`${detail}. ${IMESSAGE_FULL_DISK_ACCESS_HINT}`, { cause: error })
        }
        // The standalone chat command surfaces a schema/configuration
        // incompatibility once; serve keeps the daemon alive and retries.
        if (error instanceof ImessageSchemaError && options.retrySchemaErrors !== true) throw error
        failures += 1
        log(`[imessage] poll error ${messageOf(error)}`)
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

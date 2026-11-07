/**
 * Bounded ingress for resident serve loops. Prevents unbounded in-flight
 * `ingestAsync` work when polls return large batches (backpressure).
 */

import type { Runtime } from '../runtime.ts'
import type { Trigger } from '../shared/types.ts'

export const DEFAULT_RESIDENT_INGRESS_LIMIT = 256

export class ResidentIngressRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResidentIngressRejectedError'
  }
}

/** Thrown when ingress is cancelled via `AbortSignal` (must not advance durable cursors). */
export class ResidentIngressAbortedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResidentIngressAbortedError'
  }
}

/**
 * Parse `DS_AGENT_RESIDENT_INGRESS_LIMIT`.
 * Non-negative integers; invalid values fall back to default.
 * `0` disables the cap (explicit unbounded opt-out for operators who accept the risk).
 */
export function residentIngressLimitFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DS_AGENT_RESIDENT_INGRESS_LIMIT?.trim()
  if (raw === undefined || raw === '') return DEFAULT_RESIDENT_INGRESS_LIMIT
  const value = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(value) || value < 0) return DEFAULT_RESIDENT_INGRESS_LIMIT
  return value
}

function abortOrThrow(signal: AbortSignal | undefined, channel: 'feishu' | 'imessage'): void {
  if (signal?.aborted) {
    throw new ResidentIngressAbortedError(`[${channel}] ingress aborted`)
  }
}

/** Sleep that rejects with {@link ResidentIngressAbortedError} when aborted; always removes listeners. */
function waitAbortable(ms: number, signal: AbortSignal | undefined, channel: 'feishu' | 'imessage'): Promise<void> {
  abortOrThrow(signal, channel)
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (onSettled: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      onSettled()
    }
    const onAbort = (): void => {
      finish(() => {
        reject(new ResidentIngressAbortedError(`[${channel}] ingress aborted while waiting`))
      })
    }
    timer = setTimeout(() => {
      finish(resolve)
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Wait until in-flight resident ingests are below the configured cap, then
 * run `ingestAsync`. Throws when the queue cannot accept another trigger
 * after a bounded wait (poll cycle should retry without advancing the cursor).
 *
 * `limit === 0` skips depth accounting (explicit unbounded opt-out via env).
 */
export async function ingestResidentTrigger(
  runtime: Runtime,
  trigger: Trigger,
  options: {
    limit?: number
    signal?: AbortSignal
    log?: (line: string) => void
    channel: 'feishu' | 'imessage'
    /** Max wait when saturated before ResidentIngressRejectedError (default 60s). */
    saturateWaitMs?: number
  },
): Promise<void> {
  const limit = options.limit ?? DEFAULT_RESIDENT_INGRESS_LIMIT
  const log = options.log ?? (() => undefined)
  abortOrThrow(options.signal, options.channel)

  if (limit === 0) {
    await runtime.ingestAsync(trigger)
    return
  }

  const waitCap = options.saturateWaitMs ?? 60_000
  const deadline = Date.now() + waitCap
  while (!runtime.tryResidentIngressBegin(limit)) {
    abortOrThrow(options.signal, options.channel)
    if (Date.now() >= deadline) {
      throw new ResidentIngressRejectedError(
        `[${options.channel}] ingress saturated depth=${runtime.residentIngressDepth} limit=${limit}`,
      )
    }
    await waitAbortable(10, options.signal, options.channel)
  }

  try {
    abortOrThrow(options.signal, options.channel)
    await runtime.ingestAsync(trigger)
    log(`[${options.channel}] ingested id=${trigger.id} residentDepth=${runtime.residentIngressDepth}`)
  } finally {
    runtime.residentIngressEnd()
  }
}

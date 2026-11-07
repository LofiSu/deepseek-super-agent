/**
 * Bounded ingress for resident serve loops. Prevents unbounded in-flight
 * `ingestAsync` work when polls return large batches (backpressure).
 */

import type { Runtime } from '../runtime.ts'
import type { Trigger } from '../shared/types.ts'

export const DEFAULT_RESIDENT_INGEST_LIMIT = 256

export class ResidentIngressRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResidentIngressRejectedError'
  }
}

/** Parse `DS_AGENT_RESIDENT_INGRESS_LIMIT`; invalid values fall back to default. */
export function residentIngressLimitFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DS_AGENT_RESIDENT_INGRESS_LIMIT?.trim()
  if (raw === undefined || raw === '') return DEFAULT_RESIDENT_INGEST_LIMIT
  const value = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(value) || value < 0) return DEFAULT_RESIDENT_INGEST_LIMIT
  return value
}

/**
 * Wait until in-flight resident ingests are below the configured cap, then
 * run `ingestAsync`. Throws when the queue cannot accept another trigger
 * after a bounded wait (poll cycle should retry without advancing the cursor).
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
  const limit = options.limit ?? DEFAULT_RESIDENT_INGEST_LIMIT
  const log = options.log ?? (() => undefined)
  if (limit === 0) {
    await runtime.ingestAsync(trigger)
    return
  }

  const waitCap = options.saturateWaitMs ?? 60_000
  const deadline = Date.now() + waitCap
  while (runtime.residentIngressDepth >= limit) {
    if (options.signal?.aborted) return
    if (Date.now() >= deadline) {
      throw new ResidentIngressRejectedError(
        `[${options.channel}] ingress saturated depth=${runtime.residentIngressDepth} limit=${limit}`,
      )
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 10)
      options.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }

  runtime.residentIngressBegin()
  try {
    await runtime.ingestAsync(trigger)
  } finally {
    runtime.residentIngressEnd()
  }

  log(`[${options.channel}] ingested id=${trigger.id} residentDepth=${runtime.residentIngressDepth}`)
}

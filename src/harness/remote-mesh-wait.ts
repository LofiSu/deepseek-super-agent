/** Default wait for an `assignment_result` after a delivered remote dispatch (30 min). */
export const DEFAULT_REMOTE_RESULT_TIMEOUT_MS = 1_800_000

/**
 * Largest delay Node.js `setTimeout` honours. Larger values overflow the
 * signed 32-bit timer field and are clamped by Node down to 1 ms.
 */
export const MAX_REMOTE_RESULT_TIMEOUT_MS = 2_147_483_647

function clampRemoteResultTimeoutMs(value: number): number {
  return Math.min(Math.floor(value), MAX_REMOTE_RESULT_TIMEOUT_MS)
}

export function remoteResultTimeoutMsFromEnv(
  env: NodeJS.ProcessEnv,
  override?: number,
): number {
  if (override !== undefined && Number.isFinite(override) && override >= 0) {
    return clampRemoteResultTimeoutMs(override)
  }
  const raw = env.DS_AGENT_REMOTE_RESULT_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_REMOTE_RESULT_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_REMOTE_RESULT_TIMEOUT_MS
  return clampRemoteResultTimeoutMs(parsed)
}

/**
 * Arms a timer per ticket after remote dispatch is delivered. Cleared when the
 * host applies `assignment_result` or the Runtime shuts down.
 */
export class RemoteMeshResultWait {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly timeoutMs: number,
    private readonly onTimeout: (ticketId: string, assignmentId: string) => void,
  ) {}

  arm(ticketId: string, assignmentId: string): void {
    this.clear(ticketId)
    if (this.timeoutMs <= 0) return
    const delayMs = Math.min(this.timeoutMs, MAX_REMOTE_RESULT_TIMEOUT_MS)
    const timer = setTimeout(() => {
      this.timers.delete(ticketId)
      this.onTimeout(ticketId, assignmentId)
    }, delayMs)
    timer.unref?.()
    this.timers.set(ticketId, timer)
  }

  clear(ticketId: string): void {
    const timer = this.timers.get(ticketId)
    if (!timer) return
    clearTimeout(timer)
    this.timers.delete(ticketId)
  }

  clearAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}

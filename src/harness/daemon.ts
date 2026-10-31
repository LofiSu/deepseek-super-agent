import type { TurnResult } from '../shared/ports.js'
import type { SessionLog } from './session.js'

export interface DaemonOptions {
  sessions: SessionLog
  runTurn(sessionId: string): Promise<TurnResult>
  intervalMs?: number
}

/** Keep-alive loop. Resumes sessions left running or waiting, and stops without dropping an in-flight turn. */
export class Daemon {
  private timer: ReturnType<typeof setInterval> | undefined
  private stopping = false
  private readonly inflight = new Set<string>()
  private readonly waiters: (() => void)[] = []
  private readonly intervalMs: number

  constructor(private readonly options: DaemonOptions) {
    this.intervalMs = options.intervalMs ?? 1000
  }

  start(): void {
    if (this.timer) return
    this.stopping = false
    this.timer = setInterval(() => {
      void this.resume()
    }, this.intervalMs)
    this.timer.unref?.()
    void this.resume()
  }

  /** Run one pass over unfinished sessions. */
  async resume(): Promise<string[]> {
    if (this.stopping) return []
    const ids = this.options.sessions.unfinished()
      .map(state => state.id)
      .filter(id => !this.inflight.has(id))
    for (const id of ids) {
      if (this.stopping) break
      this.inflight.add(id)
      try {
        await this.options.runTurn(id)
      } catch {
        // A failed turn stays unfinished for a later resume and must not kill the process.
      } finally {
        this.inflight.delete(id)
        this.flush()
      }
    }
    return ids
  }

  /** Stop the timer and wait until the current turn finishes. Further resumes no-op. */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    if (this.inflight.size === 0) return
    await new Promise<void>(resolve => {
      this.waiters.push(resolve)
    })
  }

  private flush(): void {
    if (this.inflight.size > 0) return
    for (const resolve of this.waiters.splice(0)) resolve()
  }
}

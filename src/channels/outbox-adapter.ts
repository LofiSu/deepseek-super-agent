import type { OutboxRow } from '../shared/types.ts'
import type { Store } from '../store/sqlite.ts'

/** One real-channel sender. `channel` must match the Row's norms key (`im`, `github`, `cli`). */
export interface OutboundAdapter {
  readonly channel: string
  send(row: OutboxRow): Promise<{ externalId: string }>
}

export interface OutboxResult {
  sent: number
  failed: number
  pending: number
}

export interface OutboxOptions {
  log?: (line: string) => void
}

/**
 * Durable outbox dispatcher. `Replies` only enqueues; this class is the single
 * place that calls a real channel API and then records the provider message id.
 *
 * `flush()` is serialized: a slow Feishu/GitHub call never causes the same row
 * to be posted twice by an overlapping interval.
 */
export class Outbox {
  private timer?: ReturnType<typeof setInterval>
  private chain: Promise<unknown> = Promise.resolve()
  private readonly log: (line: string) => void

  constructor(
    private readonly store: Store,
    private readonly adapters: readonly OutboundAdapter[],
    options: OutboxOptions = {},
  ) {
    this.log = options.log ?? (() => undefined)
  }

  start(intervalMs = 500): void {
    if (this.timer) return
    void this.flush().catch(() => undefined)
    this.timer = setInterval(() => { void this.flush().catch(() => undefined) }, intervalMs)
    // Do not keep a short-lived demo process alive just for the outbox timer.
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  flush(): Promise<OutboxResult> {
    const next = this.chain.then(() => this.flushOnce())
    this.chain = next.then(() => undefined, () => undefined)
    return next
  }

  private async flushOnce(): Promise<OutboxResult> {
    if (!this.store.isOpen) return { sent: 0, failed: 0, pending: 0 }
    let sent = 0
    let failed = 0
    for (const row of this.store.listOutbox('pending')) {
      const adapter = this.adapters.find(item => item.channel === row.channel)
      if (!adapter) {
        // Local CLI output has no remote hop; keep it non-blocking but explicit.
        if (row.channel === 'cli') {
          this.store.markOutboxSent(row.id, `cli_${row.id}`)
          this.store.markReplySent(row.replyId)
          sent += 1
          this.log(`[outbox] sent outboxId=${row.id} channel=cli externalId=cli_${row.id}`)
          continue
        }
        const error = `no outbound adapter for channel ${row.channel}`
        this.store.markOutboxFailed(row.id, error)
        failed += 1
        this.log(`[outbox] failed outboxId=${row.id} channel=${row.channel} error=${error}`)
        continue
      }
      try {
        const result = await adapter.send(row)
        this.store.markOutboxSent(row.id, result.externalId)
        this.store.markReplySent(row.replyId)
        sent += 1
        this.log(`[outbox] sent outboxId=${row.id} channel=${row.channel} externalId=${result.externalId}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.store.markOutboxFailed(row.id, message)
        failed += 1
        this.log(`[outbox] failed outboxId=${row.id} channel=${row.channel} error=${message}`)
      }
    }
    const pending = this.store.listOutbox('pending').length
    return { sent, failed, pending }
  }
}

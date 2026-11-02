import type { Metrics } from '../metrics/metrics.ts'
import type { SourceScope } from '../shared/ports.ts'
import type { Ticket } from '../shared/types.ts'
import type { Store } from '../store/sqlite.ts'

export interface Host {
  repo: Store
  log: (line: string) => void
  now: () => string
  scope: SourceScope
  metrics: Metrics
  onQueued?: (threadKey: string, triggerId: string, pending: readonly string[]) => void
  /** Lifecycle hook. Must not throw into the Engine transaction. */
  onTicketCreated?: (ticket: Ticket) => void
  /** Lifecycle hook for every terminal ticket path (deliver, discard, stop, fail). */
  onTicketEnded?: (ticket: Ticket) => void
  /** Gate deferred this Thread; the Main Agent should assess the queued Triggers. */
  onAssessmentNeeded?: (threadKey: string) => void
}

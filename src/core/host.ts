import type { Metrics } from '../metrics/metrics.ts'
import type { SourceScope } from '../shared/ports.ts'
import type { Store } from '../store/sqlite.ts'

export interface Host {
  repo: Store
  log: (line: string) => void
  now: () => string
  scope: SourceScope
  metrics: Metrics
  onQueued?: (threadKey: string, triggerId: string, pending: readonly string[]) => void
}

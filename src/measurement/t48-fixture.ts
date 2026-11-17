/** Retention values matching Runtime defaults for the offline T48 fixture. */
export const FIXTURE_RETENTION = {
  maxEntries: 1000,
  maxAgeDays: 90,
  coldMaxEntries: 200,
  coldMaxAgeDays: 3650,
} as const

/** Reader ticket used for fixture recall and ACL checks. */
export const FIXTURE_READER = 'ticket_month_reader'

/** One synthetic observation month per fixture corpus entry. */
export const SYNTHETIC_MONTHS = [
  '2026-01-15T12:00:00.000Z',
  '2026-02-15T12:00:00.000Z',
  '2026-03-15T12:00:00.000Z',
  '2026-04-15T12:00:00.000Z',
] as const

/** Fixture-only observation date, more than 90 days after the last corpus entry. */
export const OBSERVATION_DATE = '2026-07-15T12:00:00.000Z'

export interface FixtureEntry {
  thread: string
  text: string
  createdAt: string
}

/** Small corpus for deterministic month-scale protocol and persistent measurement tests. */
export const FIXTURE_CORPUS: readonly FixtureEntry[] = [
  {
    thread: 'billing',
    text: 'invoice csv rejected blank rows',
    createdAt: SYNTHETIC_MONTHS[0],
  },
  {
    thread: 'gateway',
    text: 'gateway bearer token rotated after incident',
    createdAt: SYNTHETIC_MONTHS[1],
  },
  {
    thread: 'deploy',
    text: 'deploy pipeline paused during incident review',
    createdAt: SYNTHETIC_MONTHS[2],
  },
  {
    thread: 'semantic-topic',
    text: 'idempotency key rejected',
    createdAt: SYNTHETIC_MONTHS[3],
  },
]

export interface ProtocolQuery {
  id: string
  text: string
  relevantThread: string
}

export const PROTOCOL_QUERIES: readonly ProtocolQuery[] = [
  { id: 'billing', text: 'invoice csv rejected blank rows', relevantThread: 'billing' },
  { id: 'gateway', text: 'gateway bearer token rotated', relevantThread: 'gateway' },
  { id: 'deploy', text: 'deploy pipeline incident review', relevantThread: 'deploy' },
  { id: 'semantic', text: 'idempotent keys', relevantThread: 'semantic-topic' },
]

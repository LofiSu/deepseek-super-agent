/**
 * Connector data contracts.
 *
 * A connector record is read-only source material from an owner-authorized
 * account. It is indexed separately from long-term memory: indexing a record
 * never writes an `ltm` entry and never becomes a Ticket by itself. Only the
 * wake policy may turn one specific record into an ordinary Trigger.
 *
 * This module owns the seven Google Workspace products that the official
 * Instinct privacy policy names. No Slack, Notion, or other connector is
 * implied by this list.
 */

export const GOOGLE_SERVICES = [
  'calendar',
  'gmail',
  'drive',
  'docs',
  'sheets',
  'slides',
  'tasks',
] as const

export type GoogleService = (typeof GOOGLE_SERVICES)[number]

export function isGoogleService(value: unknown): value is GoogleService {
  return typeof value === 'string' && (GOOGLE_SERVICES as readonly string[]).includes(value)
}

/** How a connector record is used in a query, not a provider-specific type. */
export type ConnectorKind = 'message' | 'event' | 'file' | 'document' | 'task'

export const CONNECTOR_KINDS: readonly ConnectorKind[] = [
  'message',
  'event',
  'file',
  'document',
  'task',
]

export interface ConnectorDraft {
  service: GoogleService
  kind: ConnectorKind
  /** Provider id. Stable within a service. */
  externalId: string
  title: string
  /** Redacted-at-write body or summary. */
  text: string
  /** When the source item says it happened (ISO 8601). */
  occurredAt: string
  /** Last source-side change (ISO 8601). Also part of the wake fingerprint. */
  updatedAt: string
  url?: string
  participants?: string[]
  labels?: string[]
  /**
   * The provider adapter's deterministic usefulness signal. The wake policy
   * still applies admission, quiet hours, caps, and a target-thread check.
   */
  wake?: boolean
  /** Short, provider-neutral reason shown to the Router. */
  wakeReason?: string
}

export interface ConnectorRecord extends ConnectorDraft {
  /** Index id, derived from service + external id. */
  id: string
  /** When this index row was last written. */
  indexedAt: string
}

export interface ConnectorQuery {
  /** Free text. Empty means "recent records subject to the other filters". */
  text?: string
  service?: GoogleService
  kind?: ConnectorKind
  /** Inclusive lower bound on `occurredAt`. */
  since?: string
  /** Exclusive upper bound on `occurredAt`. */
  until?: string
  /** Only records the provider marked wake-worthy. */
  wakeOnly?: boolean
  limit?: number
}

/** Collision-free deterministic index id. Never used as a capability or filesystem path. */
export function connectorRecordId(service: GoogleService, externalId: string): string {
  const encoded = Array.from(externalId, character =>
    character.codePointAt(0)!.toString(16).padStart(6, '0'),
  ).join('')
  return `conn_${service}_${encoded}`
}

/** Bound a provider value before it becomes log or prompt text. */
export function oneLine(value: string, max = 240): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

/** Small deterministic hash for trigger ids; collisions are handled by dedupe. */
export function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

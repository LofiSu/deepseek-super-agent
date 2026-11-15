import type { Recovery } from './assignments.ts'

/** Persisted recovery scan outcome (ADR-004). One row per process start attempt. */
export const RECOVERY_BOUNDARY_DOC_ID = 'latest'

export type RecoveryBoundaryOutcome =
  | 'deferred'
  | 'scan_failed'
  | 'completed'

export type RecoveryTicketTransition =
  | 'recovered'
  | 'relaunch_only'
  | 'relaunch_scheduled'
  | 'launch_failed'

export interface RecoveryBoundaryTicket {
  ticketId: string
  transition: RecoveryTicketTransition
  replacementAssignmentId?: string
  interruptedAssignmentIds?: string[]
}

export interface RecoveryBoundaryRecord {
  schemaVersion: 1
  attemptedAt: string
  model: string
  outcome: RecoveryBoundaryOutcome
  /** Set when `outcome === 'deferred'`. */
  deferReason?: string
  /** Set when `outcome === 'scan_failed'`. */
  error?: string
  tickets: RecoveryBoundaryTicket[]
}

export function recoveryBoundaryFromOutcomes(
  model: string,
  attemptedAt: string,
  outcome: RecoveryBoundaryOutcome,
  recovered: readonly Recovery[],
  extras?: { deferReason?: string; error?: string },
): RecoveryBoundaryRecord {
  const tickets: RecoveryBoundaryTicket[] = recovered.map(item => ({
    ticketId: item.ticketId,
    transition: item.relaunchOnly ? 'relaunch_only' : 'recovered',
    replacementAssignmentId: item.replacementAssignmentId,
    interruptedAssignmentIds: item.interruptedAssignmentIds,
  }))
  return {
    schemaVersion: 1,
    attemptedAt,
    model,
    outcome,
    deferReason: extras?.deferReason,
    error: extras?.error,
    tickets,
  }
}

export function recordLaunchScheduled(
  record: RecoveryBoundaryRecord,
  ticketId: string,
): RecoveryBoundaryRecord {
  const tickets = record.tickets.map(entry => entry.ticketId === ticketId
    ? { ...entry, transition: 'relaunch_scheduled' as const }
    : entry)
  return { ...record, tickets }
}

export function recordLaunchFailed(
  record: RecoveryBoundaryRecord,
  ticketId: string,
): RecoveryBoundaryRecord {
  const tickets = record.tickets.map(entry => entry.ticketId === ticketId
    ? { ...entry, transition: 'launch_failed' as const }
    : entry)
  return { ...record, tickets }
}

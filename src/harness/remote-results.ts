import type { Store } from '../store/sqlite.ts'
import type { WorkerReport } from '../shared/ports.ts'

const DOC_PREFIX = 'mesh_result_'

export interface RemoteAssignmentResult {
  ticketId: string
  assignmentId: string
  report: WorkerReport
  deliveryKey: string
  peerId: string
}

function docId(peerId: string, deliveryKey: string): string {
  // Length-prefix the peerId so the boundary stays recoverable when either
  // field contains ':'. Without it, (peerId "a", deliveryKey "b:c") and
  // (peerId "a:b", deliveryKey "c") would share one document id and whichever
  // pair recorded first would mark the other pair's genuine result as a
  // duplicate. The deliveryKey is the tail, so its own ':' characters are safe.
  return `${DOC_PREFIX}${peerId.length}:${peerId}:${deliveryKey}`
}

/**
 * Idempotent apply: a duplicate (peerId, deliveryKey) pair is ignored.
 * Returns whether this call applied.
 */
export function recordRemoteResult(
  store: Store,
  result: RemoteAssignmentResult,
): boolean {
  if (!store.isOpen) return false
  const id = docId(result.peerId, result.deliveryKey)
  if (store.getDoc('mesh', id)) return false
  store.putDoc('mesh', id, {
    ...result,
    at: new Date().toISOString(),
  })
  return true
}

export function remoteResultSeen(store: Store, peerId: string, deliveryKey: string): boolean {
  return !!store.getDoc('mesh', docId(peerId, deliveryKey))
}

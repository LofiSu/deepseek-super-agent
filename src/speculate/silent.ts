import type { EnvPort } from '../shared/ports.ts'

/** Public lists hide speculative tickets until the deliver gate commits them. */
export function visibleTickets<T extends { speculative: boolean }>(tickets: readonly T[]): T[] {
  return tickets.filter(ticket => !ticket.speculative)
}

export type SurfaceVerdict = 'deliver' | 'discard' | 'hold'

/**
 * Speculative bash/write land in a scratch workdir.
 * Discard deletes it. Deliver promotes it into the durable workspace.
 * A hold (progress) leaves the scratch in place.
 */
export function settleSpeculation(env: EnvPort, sessionId: string, verdict: SurfaceVerdict): void {
  if (verdict === 'discard') env.discardIsolated?.(sessionId)
  else if (verdict === 'deliver') env.promoteIsolated?.(sessionId)
}

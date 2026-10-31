import { UserError } from '../shared/errors.ts'
import type { Store } from '../store/sqlite.ts'

/** One page. A granted reader still does not receive an unbounded body. */
export const SPILL_PAGE = 200

export function grantTicketSpill(store: Store, spillId: string | undefined, ticketId: string): void {
  if (!spillId) return
  store.grantSpill(spillId, `ticket:${ticketId}`)
  store.grantSpill(spillId, `session:worker_${ticketId}`)
}

export interface SpillPage {
  id: string
  total: number
  offset: number
  text: string
  truncated: boolean
  nextOffset?: number
}

/**
 * Ticket or session scope is required. A spill id alone is not a capability.
 * The returned text is one page, never the whole object when it is longer.
 */
export function readSpillFor(
  store: Store,
  spillId: string,
  actor: { ticketId?: string; sessionId?: string },
  opts?: { offset?: number; limit?: number },
): SpillPage {
  const body = store.getSpill(spillId)
  if (body == null) throw new UserError(`unknown spill ${spillId}`)
  const grants = store.spillGrants(spillId)
  const allowed = (actor.ticketId != null && grants.includes(`ticket:${actor.ticketId}`))
    || (actor.sessionId != null && grants.includes(`session:${actor.sessionId}`))
  if (!allowed) throw new UserError(`spill ${spillId} is not visible to this session`)
  const offset = Math.max(0, Math.floor(opts?.offset ?? 0))
  const asked = opts?.limit == null ? SPILL_PAGE : Math.floor(opts.limit)
  const limit = Math.min(SPILL_PAGE, Math.max(1, asked))
  const text = body.slice(offset, offset + limit)
  const truncated = offset + text.length < body.length
  return {
    id: spillId,
    total: body.length,
    offset,
    text,
    truncated,
    nextOffset: truncated ? offset + text.length : undefined,
  }
}
/** Speculative work stays silent until a report is worth delivering. */
export function isSpeculative(meta: Record<string, unknown>, strength: string): boolean {
  return meta.speculate === true || strength === 'maybe'
}

/**
 * Visibility bit used by older callers.
 * Speculative work needs an explicit `deliver === true`.
 * Prefer `evaluateDeliver`, which also requires a value signal.
 */
export function maySurface(speculative: boolean, deliver: boolean | undefined): boolean {
  if (!speculative) return deliver !== false
  return deliver === true
}

export type DeliverDecision = 'deliver' | 'discard' | 'hold'

/** Outcome words. The report kind `ready` is not itself a value signal. */
const VALUE = /\b(fixed|reproduced|passing|recorded|resolved|patched|green|root cause)\b/i

export function hasDeliverValue(text: string): boolean {
  return VALUE.test(text)
}

export interface DeliverInput {
  speculative: boolean
  kind: string
  text: string
  deliver?: boolean
}

/**
 * Speculative `ready` delivers only when the worker asks and the summary has a value signal.
 * `failed` / `dropped` are discarded with no outbound reply. Other kinds are held.
 * A non-speculative report with `deliver === false` is held; terminal kinds still end.
 */
export function evaluateDeliver(input: DeliverInput): DeliverDecision {
  if (!input.speculative) return input.deliver === false ? 'hold' : 'deliver'
  if (input.kind === 'failed' || input.kind === 'dropped') return 'discard'
  if (input.kind !== 'ready') return 'hold'
  if (input.deliver === true && hasDeliverValue(input.text)) return 'deliver'
  return 'discard'
}

export function isPublicTicket(ticket: { speculative?: boolean }): boolean {
  return ticket.speculative !== true
}

export function visibleTickets<T extends { speculative?: boolean }>(tickets: readonly T[], includeHidden = false): T[] {
  if (includeHidden) return [...tickets]
  return tickets.filter(isPublicTicket)
}

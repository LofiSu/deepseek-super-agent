import type { Strength, Ticket } from '../shared/types.ts'

/**
 * Speculative work stays silent until a report explicitly delivers.
 * This is derived from the ingress-owned strength, never from `trigger.meta`.
 */
export function isSpeculative(strength: Strength): boolean {
  return strength === 'maybe'
}

/**
 * Outbound copy may leave the process only when the ticket is public,
 * or a speculative report has been committed with deliver=true.
 */
export function maySurface(speculative: boolean, deliver: boolean | undefined): boolean {
  if (!speculative) return deliver !== false
  return deliver === true
}

export interface GateReport {
  kind: string
  text: string
  deliver?: boolean
}

export interface DeliverGate {
  /** Called after a speculative assignment reports ready, failed, or dropped. */
  evaluate(input: { ticket: Ticket; report: GateReport }): 'deliver' | 'discard'
}

const NEGATIVE = /\b(nothing|no change|unable|could not|cannot|not valuable|wontfix|won't fix)\b/i
const POSITIVE = /\b(ready|fixed|fix|reproduced|reproduce|valuable|found|resolved|patch|passing|passed)\b/i

/**
 * Clause-local verdict: a negative clause wins inside itself ("could not fix"),
 * but a later positive clause wins overall ("could not reproduce, but fixed it").
 * Still a heuristic stand-in for the plan's value signal; see docs/REVIEW.md.
 */
function valuable(text: string): boolean {
  const clauses = text.split(/[.;!?\n]+/).map(clause => clause.trim()).filter(Boolean)
  let sawPositive = false
  for (const clause of clauses) {
    if (NEGATIVE.test(clause) && !POSITIVE.test(clause)) return false
    if (NEGATIVE.test(clause) && POSITIVE.test(clause)) continue
    if (POSITIVE.test(clause)) sawPositive = true
  }
  return sawPositive
}

/** ready + an explicit deliver vote or a value signal commits; failed/dropped roll back. */
export class HeuristicDeliverGate implements DeliverGate {
  evaluate(input: { ticket: Ticket; report: GateReport }): 'deliver' | 'discard' {
    const { ticket, report } = input
    if (report.kind === 'dropped' || report.kind === 'failed') return 'discard'
    if (!ticket.speculative) return report.deliver === false ? 'discard' : 'deliver'
    if (report.kind !== 'ready') return 'discard'
    if (report.deliver === true) return 'deliver'
    return valuable(report.text) ? 'deliver' : 'discard'
  }
}

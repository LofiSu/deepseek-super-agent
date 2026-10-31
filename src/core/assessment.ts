import type { DecisionKind, Ticket, Trigger } from '../shared/types.ts'

export type AssessmentCommand = 'unavailable' | 'stop' | 'ignore'

/**
 * Commands that must reach Eval even on a subscribed thread.
 * Anchored so a later "please fix" is not treated as a stop or an ignore.
 */
const UNAVAILABLE = /^(?:@ds-agent\s+)?(?:please\s+)?(?:assessment unavailable|model unavailable|cannot assess)\b/i
const STOP = /^(?:@ds-agent\s+)?(?:please\s+)?(?:stop|cancel|abort)\b/i
const IGNORE = /^(?:@ds-agent\s+)?(?:please\s+)?(?:ignore this|no action needed|fyi only)\b/i

export interface Assessment {
  kind: DecisionKind
  reason: string
  ticketId?: string
}

export function commandOf(text: string): AssessmentCommand | null {
  const line = text.trim()
  if (UNAVAILABLE.test(line)) return 'unavailable'
  if (STOP.test(line)) return 'stop'
  if (IGNORE.test(line)) return 'ignore'
  return null
}

/**
 * Gate + assessment for one batch. Only `accept` may open a ticket.
 * `live` is the winning open subscriber on the thread, if any.
 */
export function assessTriggers(triggers: Trigger[], live: Ticket | undefined): Assessment {
  const primary = triggers.find(trigger => trigger.addressed) ?? triggers[0]
  if (!primary) return { kind: 'ignore', reason: 'empty-batch' }
  const command = commandOf(primary.text)
  if (command === 'unavailable') return { kind: 'unavailable', reason: 'assessor-unavailable' }
  if (command === 'stop') {
    if (!live) return { kind: 'ignore', reason: 'nothing-to-stop' }
    return { kind: 'stop', reason: 'stop-requested', ticketId: live.id }
  }
  if (command === 'ignore') return { kind: 'ignore', reason: 'no-action' }
  return { kind: 'accept', reason: 'actionable' }
}
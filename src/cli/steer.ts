import { parseThreadKey } from '../ingress/thread.ts'
import { UserError } from '../shared/errors.ts'
import type { Ticket, Trigger } from '../shared/types.ts'

export interface HumanPrompt {
  ticketId: string
  title: string
  text: string
}

/** Human follow-up aimed at a live ticket's thread. Intake fans it out on the subscription. */
export function steerTrigger(ticket: Ticket, text: string, id?: string): Trigger {
  const key = ticket.threadKeys[0]
  if (!key) throw new UserError(`ticket ${ticket.id} has no thread`)
  const thread = parseThreadKey(key)
  const body = text.trim()
  if (!body) throw new UserError('steer needs text')
  return {
    id: id ?? `trg_steer_${ticket.id}_${Date.now().toString(36)}`,
    source: thread.source,
    threads: [thread],
    actor: { source: 'cli', id: 'you' },
    human: true,
    addressed: 'direct',
    at: new Date().toISOString(),
    text: body,
    channel: { source: 'cli', thread: thread.id },
    meta: { steer: true, ticketId: ticket.id },
  }
}

/** Tickets whose latest report is waiting on a person. */
export function waitingForHuman(tickets: readonly Ticket[]): HumanPrompt[] {
  const rows: HumanPrompt[] = []
  for (const ticket of tickets) {
    if (ticket.ended) continue
    const report = ticket.assignments.at(-1)?.report
    if (report?.kind !== 'waiting') continue
    rows.push({ ticketId: ticket.id, title: ticket.title, text: report.text })
  }
  return rows
}

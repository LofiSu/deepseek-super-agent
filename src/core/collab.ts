import { UserError } from '../shared/errors.ts'
import type { Collaboration, Guidance, Ticket } from '../shared/types.ts'
import type { Host } from './host.ts'

export interface PauseInput {
  /** Who paused the task. Defaults to `human` (the CLI). */
  by?: string
  reason?: string
}

export interface InterveneInput extends PauseInput {
  actor?: string
  /** Inject guidance without pausing. Default true: a human note stops the task first. */
  pause?: boolean
}

export interface PauseOutcome {
  ticket: Ticket
  /** True when this call actually set the pause; false when it was already paused. */
  changed: boolean
}

export interface InterveneOutcome {
  ticket: Ticket
  guidance: Guidance
  /** True when the ticket is paused after this call. */
  paused: boolean
}

export interface ResumeOutcome {
  ticket: Ticket
  /** False when the ticket was not paused (or is already ended). */
  resumed: boolean
  pausedAt?: string
}

export interface CollaborationView {
  ticket: Ticket
  collaboration: Collaboration
}

/**
 * Mid-task collaboration rules. Engine commands wrap each call in one transaction.
 * The paused flag lives on the Ticket document, so it is read and written through SQLite.
 */
export class Collaborations {
  constructor(private readonly host: Host) {}

  pause(ticketId: string, input: PauseInput = {}): PauseOutcome {
    const ticket = this.mustLive(ticketId, 'pause')
    const collaboration = ensureCollaboration(ticket)
    if (collaboration.paused) {
      this.host.log(`[collab] pause ticketId=${ticket.id} already-paused at=${collaboration.paused.at}`)
      return { ticket, changed: false }
    }
    const at = this.host.now()
    collaboration.paused = {
      at,
      by: input.by ?? 'human',
      ...(input.reason ? { reason: input.reason } : {}),
    }
    this.host.repo.putDoc('ticket', ticket.id, ticket)
    this.host.repo.addEvent('ticket.paused', {
      ticketId: ticket.id,
      at,
      by: collaboration.paused.by,
      reason: input.reason,
    })
    this.host.log(
      `[collab] pause ticketId=${ticket.id} at=${at} by=${collaboration.paused.by} reason=${input.reason ?? '-'}`,
    )
    return { ticket, changed: true }
  }

  intervene(ticketId: string, text: string, input: InterveneInput = {}): InterveneOutcome {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) throw new UserError('intervention needs non-empty guidance text')
    const ticket = this.mustLive(ticketId, 'intervene on')
    const collaboration = ensureCollaboration(ticket)
    const at = this.host.now()
    const guidance: Guidance = {
      id: this.host.repo.nextId('guide'),
      at,
      actor: input.actor ?? input.by ?? 'human',
      text: clean,
    }
    collaboration.guidance.push(guidance)
    this.host.repo.addEvent('collab.guidance', {
      ticketId: ticket.id,
      guidanceId: guidance.id,
      actor: guidance.actor,
      text: clean,
    })
    if (input.pause !== false && !collaboration.paused) {
      collaboration.paused = {
        at,
        by: input.by ?? 'human',
        reason: input.reason ?? `intervention ${guidance.id}`,
      }
      this.host.repo.addEvent('ticket.paused', {
        ticketId: ticket.id,
        at,
        by: collaboration.paused.by,
        reason: collaboration.paused.reason,
      })
      this.host.log(`[collab] pause ticketId=${ticket.id} at=${at} by=${collaboration.paused.by} reason=intervention`)
    }
    this.host.repo.putDoc('ticket', ticket.id, ticket)
    const paused = Boolean(collaboration.paused)
    this.host.log(
      `[collab] intervene ticketId=${ticket.id} guidanceId=${guidance.id} paused=${paused} text=${clean}`,
    )
    return { ticket, guidance, paused }
  }

  resume(ticketId: string, input: PauseInput = {}): ResumeOutcome {
    const ticket = this.mustLive(ticketId, 'resume')
    const collaboration = ensureCollaboration(ticket)
    if (!collaboration.paused) {
      this.host.log(`[collab] resume ticketId=${ticket.id} already-active`)
      return { ticket, resumed: false }
    }
    const pausedAt = collaboration.paused.at
    delete collaboration.paused
    const at = this.host.now()
    collaboration.resumes.push({
      at,
      by: input.by ?? 'human',
      ...(input.reason ? { reason: input.reason } : {}),
      pausedAt,
    })
    this.host.repo.putDoc('ticket', ticket.id, ticket)
    this.host.repo.addEvent('ticket.resumed', {
      ticketId: ticket.id,
      at,
      by: input.by ?? 'human',
      reason: input.reason,
      pausedAt,
    })
    this.host.log(`[collab] resume ticketId=${ticket.id} at=${at} pausedAt=${pausedAt}`)
    return { ticket, resumed: true, pausedAt }
  }

  /**
   * Unseen guidance for one audience. The injection is recorded so a later turn
   * does not repeat it. Called by the Harness before building a Router/Worker prompt.
   */
  takeGuidance(ticketId: string, audience: 'worker' | 'router'): string[] {
    const ticket = this.host.repo.getDoc<Ticket>('ticket', ticketId)
    if (!ticket) return []
    const collaboration = ensureCollaboration(ticket)
    const texts: string[] = []
    const ids: string[] = []
    for (const guidance of collaboration.guidance) {
      if (audience === 'worker' ? guidance.seenByWorker : guidance.seenByRouter) continue
      if (audience === 'worker') guidance.seenByWorker = true
      else guidance.seenByRouter = true
      texts.push(guidance.text)
      ids.push(guidance.id)
    }
    if (texts.length === 0) return texts
    this.host.repo.putDoc('ticket', ticket.id, ticket)
    this.host.repo.addEvent('collab.guidance_injected', {
      ticketId: ticket.id,
      audience,
      guidanceIds: ids,
    })
    this.host.log(
      `[collab] guidance injected ticketId=${ticket.id} audience=${audience} count=${texts.length}`,
    )
    return texts
  }

  view(ticketId: string): CollaborationView {
    const ticket = this.host.repo.getDoc<Ticket>('ticket', ticketId)
    if (!ticket) throw new UserError(`unknown ticket ${ticketId}`)
    return { ticket, collaboration: ensureCollaboration(ticket) }
  }

  private mustLive(ticketId: string, action: string): Ticket {
    const ticket = this.host.repo.getDoc<Ticket>('ticket', ticketId)
    if (!ticket) throw new UserError(`unknown ticket ${ticketId}`)
    if (ticket.ended) {
      throw new UserError(`ticket ${ticketId} has ended (${ticket.ended.outcome}); cannot ${action} it`)
    }
    return ticket
  }
}

export function ensureCollaboration(ticket: Ticket): Collaboration {
  if (!ticket.collab) ticket.collab = { guidance: [], resumes: [] }
  if (!Array.isArray(ticket.collab.guidance)) ticket.collab.guidance = []
  if (!Array.isArray(ticket.collab.resumes)) ticket.collab.resumes = []
  return ticket.collab
}

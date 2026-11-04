import { UserError } from '../shared/errors.ts'
import type { ApprovalRequest, Collaboration, Guidance, Ticket } from '../shared/types.ts'
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

export interface RequestApprovalInput {
  action: string
  reason?: string
  /** Session id that asked. Derived from the assignment when omitted. */
  requestedBy?: string
}

export interface RequestApprovalOutcome {
  ticket: Ticket
  approval: ApprovalRequest
}

export interface DecideApprovalInput {
  by?: string
  note?: string
}

export interface DecideApprovalOutcome {
  ticket: Ticket
  approval: ApprovalRequest
  guidance: Guidance
}

/** Longest action description a Worker may put in front of the owner. */
export const MAX_APPROVAL_ACTION_CHARS = 300

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
   * Record one action the Worker will not perform without the owner. This is a
   * hold, not a pause: replies stay allowed so the Router can ask the owner,
   * while Worker turns stop on the pending entry. A ticket can have one pending
   * request at a time.
   */
  requestApproval(ticketId: string, input: RequestApprovalInput): RequestApprovalOutcome {
    const ticket = this.mustLive(ticketId, 'request approval on')
    const collaboration = ensureCollaboration(ticket)
    if (collaboration.paused) {
      throw new UserError(`ticket ${ticketId} is paused; resume it before requesting approval`)
    }
    const approvals = collaboration.approvals ?? (collaboration.approvals = [])
    if (pendingApproval(ticket)) {
      throw new UserError(`ticket ${ticketId} is already waiting for approval`)
    }
    const action = input.action.replace(/\s+/g, ' ').trim()
    if (!action) throw new UserError('approval needs the exact action')
    if (action.length > MAX_APPROVAL_ACTION_CHARS) {
      throw new UserError(`approval action is longer than ${MAX_APPROVAL_ACTION_CHARS} characters`)
    }
    const approval: ApprovalRequest = {
      id: this.host.repo.nextId('appr'),
      at: this.host.now(),
      action,
      ...(input.reason?.trim() ? { reason: input.reason.replace(/\s+/g, ' ').trim().slice(0, 300) } : {}),
      requestedBy: input.requestedBy
        || ticket.assignments.at(-1)?.workerSessionId
        || 'worker',
      status: 'pending',
    }
    approvals.push(approval)
    this.host.repo.putDoc('ticket', ticket.id, ticket)
    this.host.repo.addEvent('approval.requested', {
      ticketId: ticket.id,
      approvalId: approval.id,
      action: approval.action,
      requestedBy: approval.requestedBy,
    })
    this.host.log(
      `[approval] requested ticketId=${ticket.id} approvalId=${approval.id} action=${approval.action}`,
    )
    return { ticket, approval }
  }

  /**
   * Owner decision. Records the decision, adds guidance for the Worker, and
   * appends a resume record so a later Harness resume includes follow-ups that
   * arrived while the approval was pending. The Harness starts the RESUME turns.
   */
  decideApproval(
    ticketId: string,
    approvalId: string,
    decision: 'approved' | 'denied',
    input: DecideApprovalInput = {},
  ): DecideApprovalOutcome {
    const ticket = this.mustLive(ticketId, 'decide approval on')
    const collaboration = ensureCollaboration(ticket)
    const approvals = collaboration.approvals ?? (collaboration.approvals = [])
    const approval = approvals.find(item => item.id === approvalId)
    if (!approval) throw new UserError(`unknown approval ${approvalId} on ticket ${ticketId}`)
    if (approval.status !== 'pending') {
      throw new UserError(`approval ${approvalId} already decided (${approval.status})`)
    }
    const at = this.host.now()
    const by = input.by ?? 'human'
    const note = input.note?.replace(/\s+/g, ' ').trim()
    approval.status = decision
    approval.decidedAt = at
    approval.decidedBy = by
    if (note) approval.note = note
    const text = decision === 'approved'
      ? `Approval ${approval.id} approved: ${approval.action}.${note ? ` Note: ${note}.` : ''} Proceed with exactly that action.`
      : `Approval ${approval.id} denied: ${approval.action}. Do not perform it; report what you did instead and what you need.`
    const guidance: Guidance = {
      id: this.host.repo.nextId('guide'),
      at,
      actor: by,
      text,
    }
    collaboration.guidance.push(guidance)
    collaboration.resumes.push({
      at,
      by,
      reason: `approval ${approval.id} ${decision}`,
      pausedAt: approval.at,
    })
    this.host.repo.putDoc('ticket', ticket.id, ticket)
    this.host.repo.addEvent('approval.decided', {
      ticketId: ticket.id,
      approvalId: approval.id,
      decision,
      by,
      note,
      action: approval.action,
    })
    this.host.repo.addEvent('collab.guidance', {
      ticketId: ticket.id,
      guidanceId: guidance.id,
      actor: by,
      text,
    })
    this.host.log(
      `[approval] ${decision} ticketId=${ticket.id} approvalId=${approval.id} by=${by}`,
    )
    return { ticket, approval, guidance }
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
  if (!Array.isArray(ticket.collab.approvals)) ticket.collab.approvals = []
  return ticket.collab
}

/** The approval blocking this ticket, if any. */
export function pendingApproval(ticket: Ticket): ApprovalRequest | undefined {
  return ticket.collab?.approvals?.find(item => item.status === 'pending')
}

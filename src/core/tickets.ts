import { grantTicketSpill } from '../memory/acl.ts'
import { isSpeculative } from '../speculate/gate.ts'
import { UserError } from '../shared/errors.ts'
import { threadKey, type Decision, type Strength, type Thread, type Ticket, type Trigger } from '../shared/types.ts'
import type { Host } from './host.ts'
import type { Replies } from './replies.ts'

export class Tickets {
  constructor(private readonly host: Host, private readonly replies: Replies) {}

  create(input: {
    thread: Thread
    triggers: Trigger[]
    primary: Trigger
    strength: Strength
    evalId: string
    reason?: string
  }): Decision {
    const now = this.host.now()
    const id = this.host.repo.nextId('ticket')
    const assignmentId = this.host.repo.nextId('asg')
    const speculative = isSpeculative(input.strength)
    const label = String(input.primary.meta.label ?? input.primary.text).replace(/\s+/g, ' ').trim().slice(0, 80)
    // Engine-authored meta only: Intake rewrites `meta` before persisting the trigger.
    const spillId = typeof input.primary.meta.spillId === 'string' ? input.primary.meta.spillId : undefined
    const threadKeys = [...new Set(input.triggers.flatMap(trigger => trigger.threads.map(threadKey)))]
    const channels = input.triggers.flatMap(trigger => trigger.channel ? [trigger.channel] : [])
    if (channels.length === 0) {
      const ref = input.primary.threads[0]!
      channels.push({ source: ref.source, thread: ref.id })
    }
    const ticket: Ticket = {
      id,
      title: label,
      brief: input.primary.text,
      spillId,
      mandate: {
        strength: input.strength,
        policyVersion: 'policy-v1',
        scope: label,
        actor: input.primary.actor,
        basis: input.strength === 'explicit' ? 'addressed' : speculative ? 'speculative' : 'inferred',
      },
      threadKeys,
      channels,
      inputs: input.triggers.map(trigger => ({
        id: this.host.repo.nextId('input'),
        kind: 'trigger' as const,
        triggerId: trigger.id,
        text: trigger.text,
        spillId: typeof trigger.meta.spillId === 'string' ? trigger.meta.spillId : undefined,
        at: now,
        human: trigger.human,
      })),
      assignments: [{ id: assignmentId, state: 'pending', speculative }],
      speculative,
      originTriggerId: input.primary.id,
      createdAt: now,
    }
    this.host.repo.putDoc('ticket', id, ticket)
    grantTicketSpill(this.host.repo, spillId, id)
    for (const row of ticket.inputs) grantTicketSpill(this.host.repo, row.spillId, id)
    for (const key of threadKeys) {
      const thread = key === input.thread.key ? input.thread : this.host.repo.getDoc<Thread>('thread', key)
      if (!thread) continue
      if (!thread.subscriptions.includes(id)) thread.subscriptions.push(id)
      thread.subscriptionMeta = { ...(thread.subscriptionMeta ?? {}), [id]: { at: now } }
      this.host.repo.putDoc('thread', key, thread)
      this.host.repo.addSubscription(key, id, now)
      this.host.repo.addEvent('thread.subscribed', { threadKey: key, ticketId: id })
      this.host.log(`[engine] subscribe ticketId=${id} thread=${key}`)
    }
    const decision: Decision = {
      id: this.host.repo.nextId('dec'),
      evalId: input.evalId,
      threadKey: input.thread.key,
      triggerIds: input.triggers.map(trigger => trigger.id),
      kind: 'accept',
      ticketId: id,
      at: now,
      reason: input.reason ?? (speculative ? 'speculative' : 'accepted'),
      strength: input.strength,
    }
    this.host.repo.putDoc('decision', decision.id, decision)
    this.host.log(`[engine] Tickets.create ticketId=${id} title=${ticket.title} speculative=${ticket.speculative}`)
    this.host.log(`[engine] Evals.accept thread=${input.thread.key} ticketId=${id} strength=${input.strength}`)
    this.host.metrics.increment('eval.accept')
    this.host.repo.addEvent('ticket.created', { ticketId: id, decisionId: decision.id, speculative })
    this.host.repo.addEvent('decision.recorded', { decisionId: decision.id, kind: 'accept' })
    if (speculative) this.host.log(`[speculate] speculative silent ticketId=${id} until deliver`)
    else this.replies.acknowledge(ticket)
    this.notifyTicket('created', ticket)
    return decision
  }

  /** Observers must never abort the Engine transaction that triggered them. */
  private notifyTicket(kind: 'created' | 'ended', ticket: Ticket): void {
    const hook = kind === 'created' ? this.host.onTicketCreated : this.host.onTicketEnded
    if (!hook) return
    try {
      hook(ticket)
    } catch (error) {
      this.host.log(`[hook] hook=${kind} ticketId=${ticket.id} error=${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** End a live ticket from Eval or the Router. A stopped ticket is not resumed by the next report. */
  stop(ticketId: string, reason: string, by: 'human' | 'router' = 'human'): void {
    const ticket = this.host.repo.getDoc<Ticket>('ticket', ticketId)
    if (!ticket) throw new UserError(`unknown ticket ${ticketId}`)
    if (ticket.ended) return
    const now = this.host.now()
    const assignment = [...ticket.assignments].reverse().find(item => item.state !== 'ended')
    if (assignment) {
      assignment.state = 'ended'
      assignment.endedAt = now
      assignment.report = { kind: 'stopped', text: reason, deliver: false }
      this.host.repo.addEvent('assignment.ended', {
        ticketId: ticket.id,
        assignmentId: assignment.id,
        kind: 'stop',
      })
    }
    ticket.ended = { at: now, outcome: 'stopped', by }
    this.host.repo.putDoc('ticket', ticket.id, ticket)
    this.host.repo.addEvent('ticket.ended', { ticketId: ticket.id, outcome: 'stopped', by })
    this.notifyTicket('ended', ticket)
  }

  subscribe(ticketId: string, key: string, opts: { contextOnly?: boolean } = {}): void {
    const ticket = this.host.repo.getDoc<Ticket>('ticket', ticketId)
    const thread = this.host.repo.getDoc<Thread>('thread', key)
    if (!ticket || !thread) throw new UserError(`cannot subscribe ${ticketId} to ${key}`)
    if (!thread.subscriptions.includes(ticketId)) thread.subscriptions.push(ticketId)
    thread.subscriptionMeta = {
      ...(thread.subscriptionMeta ?? {}),
      [ticketId]: { contextOnly: opts.contextOnly === true, at: this.host.now() },
    }
    if (!ticket.threadKeys.includes(key)) ticket.threadKeys.push(key)
    this.host.repo.putDoc('thread', key, thread)
    this.host.repo.putDoc('ticket', ticketId, ticket)
    this.host.repo.addSubscription(key, ticketId, this.host.now())
    this.host.log(`[engine] subscribe ticketId=${ticketId} thread=${key}`)
  }

  /**
   * Stop following a thread. Unlike handback, the trigger is not requeued:
   * the ticket simply no longer receives subscription bypass on that thread.
   */
  unsubscribe(ticketId: string, key: string, reason = 'unsubscribe'): boolean {
    const thread = this.host.repo.getDoc<Thread>('thread', key)
    if (!thread) throw new UserError(`cannot unsubscribe ${ticketId} from ${key}`)
    const wasSubscribed = thread.subscriptions.includes(ticketId)
    thread.subscriptions = thread.subscriptions.filter(id => id !== ticketId)
    if (thread.subscriptionMeta) delete thread.subscriptionMeta[ticketId]
    this.host.repo.putDoc('thread', key, thread)
    const ticket = this.host.repo.getDoc<Ticket>('ticket', ticketId)
    if (ticket) {
      ticket.threadKeys = ticket.threadKeys.filter(item => item !== key)
      this.host.repo.putDoc('ticket', ticketId, ticket)
    }
    this.host.repo.addEvent('subscription.removed', { ticketId, threadKey: key, reason })
    this.host.log(`[engine] unsubscribe ticketId=${ticketId} thread=${key} wasSubscribed=${wasSubscribed}`)
    return wasSubscribed
  }
}
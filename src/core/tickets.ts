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
  }): Decision {
    const now = this.host.now()
    const id = this.host.repo.nextId('ticket')
    const assignmentId = this.host.repo.nextId('asg')
    const speculative = isSpeculative(input.primary.meta, input.strength)
    const label = String(input.primary.meta.label ?? input.primary.text).replace(/\s+/g, ' ').trim().slice(0, 80)
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
      reason: speculative ? 'speculative' : 'accepted',
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
    return decision
  }

  /** End a live ticket from Eval. A stopped ticket is not resumed by the next report. */
  stop(ticketId: string, reason: string): void {
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
    ticket.ended = { at: now, outcome: 'stopped', by: 'human' }
    this.host.repo.putDoc('ticket', ticket.id, ticket)
    this.host.repo.addEvent('ticket.ended', { ticketId: ticket.id, outcome: 'stopped' })
  }

  subscribe(ticketId: string, key: string): void {
    const ticket = this.host.repo.getDoc<Ticket>('ticket', ticketId)
    const thread = this.host.repo.getDoc<Thread>('thread', key)
    if (!ticket || !thread) throw new Error(`cannot subscribe ${ticketId} to ${key}`)
    if (!thread.subscriptions.includes(ticketId)) thread.subscriptions.push(ticketId)
    if (!ticket.threadKeys.includes(key)) ticket.threadKeys.push(key)
    this.host.repo.putDoc('thread', key, thread)
    this.host.repo.putDoc('ticket', ticketId, ticket)
    this.host.repo.addSubscription(key, ticketId, this.host.now())
    this.host.log(`[engine] subscribe ticketId=${ticketId} thread=${key}`)
  }
}

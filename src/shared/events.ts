import type { DecisionKind, ReceiveResult, Strength } from './types.js'

/** Fan-out log line. Must carry bypass=subscription and ticketId. */
export interface SubscriptionFanout {
  type: 'subscription.fanout'
  bypass: 'subscription'
  ticketId: string
  triggerId: string
  at: string
}

export interface DomainEventMap {
  'trigger.received': { triggerId: string; threads: string[]; result: ReceiveResult }
  'eval.started': { evalId: string; threadKey: string; triggerIds: string[]; strength: Strength }
  'decision.recorded': { decisionId: string; kind: DecisionKind; threadKey: string }
  'ticket.created': { ticketId: string; decisionId: string }
  'assignment.started': { ticketId: string; assignmentId: string }
  'subscription.fanout': SubscriptionFanout
}

export type DomainEvent = {
  [K in keyof DomainEventMap]: { type: K; at: string; data: DomainEventMap[K] }
}[keyof DomainEventMap]

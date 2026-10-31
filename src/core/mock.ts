import type { Assignment, Ticket, Trigger } from '../shared/types.js'
import type { Repositories } from '../shared/ports.js'
import type { Assessment, AssessmentInput, Assessor, Executor, Gate, GateResult } from './ports.js'

export class AllowGate implements Gate {
  constructor(private readonly strength: 'explicit' | 'inferred' = 'explicit', private readonly policyVersion = 'p1') {}

  admit(): GateResult {
    return { admissible: true, strength: this.strength, policyVersion: this.policyVersion }
  }
}

export class ScriptedGate implements Gate {
  constructor(private readonly decide: (trigger: Trigger, thread: Parameters<Gate['admit']>[1], tickets: Ticket[]) => GateResult) {}

  admit(trigger: Trigger, thread: Parameters<Gate['admit']>[1], tickets: Ticket[]): GateResult {
    return this.decide(trigger, thread, tickets)
  }
}

export class MockAssessor implements Assessor {
  readonly seen: AssessmentInput[] = []

  constructor(public answer: Assessment | undefined | ((input: AssessmentInput) => Assessment | undefined) = { kind: 'ignore' }) {}

  assess(input: AssessmentInput): Assessment | undefined {
    this.seen.push(input)
    const answer = this.answer
    return typeof answer === 'function' ? answer(input) : answer
  }
}

export class RecordingExecutor implements Executor {
  readonly started: { ticketId: string; assignmentId: string; stored?: string }[] = []
  readonly delivered: { ticketId: string; assignmentId: string; inputIds: string[] }[] = []
  readonly stopped: { ticketId: string; assignmentId: string; reason: string }[] = []

  constructor(private readonly repos?: Repositories) {}

  start(ticket: Ticket, assignment: Assignment): void {
    this.started.push({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      stored: this.repos?.tickets.get(ticket.id)?.id,
    })
  }

  deliver(ticket: Ticket, assignment: Assignment, inputIds: string[]): void {
    this.delivered.push({ ticketId: ticket.id, assignmentId: assignment.id, inputIds: [...inputIds] })
  }

  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.stopped.push({ ticketId: ticket.id, assignmentId: assignment.id, reason })
  }
}

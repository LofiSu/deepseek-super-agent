import type { DeliverGateStrategyV1 } from '../evolution/types.ts'
import type { DeliverGate, GateReport } from './gate.ts'
import type { Ticket } from '../shared/types.ts'
import { evaluateDeliverGateStrategy } from '../evolution/strategy-gate.ts'

/** Opt-in consumer: promoted evolution artifact affects delivery gating when wired explicitly. */
export class ConfigurableDeliverGate implements DeliverGate {
  constructor(private readonly strategy: DeliverGateStrategyV1) {}

  evaluate(input: { ticket: Ticket; report: GateReport }): 'deliver' | 'discard' {
    return evaluateDeliverGateStrategy(this.strategy, {
      speculative: input.ticket.speculative,
      report: input.report,
    })
  }
}

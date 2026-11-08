import type { DeliverGateStrategyV1 } from './types.ts'
import type { GateReport } from '../speculate/gate.ts'
import type { Ticket } from '../shared/types.ts'

function compile(pattern: string, label: string): RegExp {
  try {
    return new RegExp(pattern, 'i')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`invalid ${label} regex: ${message}`)
  }
}

function valuableText(strategy: DeliverGateStrategyV1, text: string): boolean {
  const negative = compile(strategy.negativePattern, 'negativePattern')
  const positive = compile(strategy.positivePattern, 'positivePattern')
  const clauses = text.split(/[.;!?\n]+/).map(clause => clause.trim()).filter(Boolean)
  let sawPositive = false
  for (const clause of clauses) {
    if (negative.test(clause)) return strategy.clauseLocalPositive ? sawPositive : false
    if (positive.test(clause)) sawPositive = true
  }
  return sawPositive
}

/** JSON strategy consumer; does not mutate production HeuristicDeliverGate until promotion. */
export function evaluateDeliverGateStrategy(
  strategy: DeliverGateStrategyV1,
  input: { speculative: boolean; report: GateReport },
): 'deliver' | 'discard' {
  const { speculative, report } = input
  const ticket = { speculative } as Ticket
  if (report.kind === 'dropped' || report.kind === 'failed') return 'discard'
  if (!ticket.speculative) return report.deliver === false ? 'discard' : 'deliver'
  if (report.deliver === true) return 'deliver'
  if (report.kind !== 'ready') return 'discard'
  return valuableText(strategy, report.text) ? 'deliver' : 'discard'
}

export function parseDeliverGateStrategy(raw: unknown): DeliverGateStrategyV1 {
  if (!raw || typeof raw !== 'object') throw new Error('strategy must be an object')
  const obj = raw as Record<string, unknown>
  if (obj.schemaVersion !== 1) throw new Error(`unsupported strategy schemaVersion ${obj.schemaVersion}`)
  if (obj.domain !== 'deliver-gate-v1') throw new Error(`unsupported strategy domain ${obj.domain}`)
  if (typeof obj.negativePattern !== 'string' || !obj.negativePattern) {
    throw new Error('negativePattern required')
  }
  if (typeof obj.positivePattern !== 'string' || !obj.positivePattern) {
    throw new Error('positivePattern required')
  }
  if (typeof obj.clauseLocalPositive !== 'boolean') throw new Error('clauseLocalPositive must be boolean')
  compile(obj.negativePattern, 'negativePattern')
  compile(obj.positivePattern, 'positivePattern')
  return obj as unknown as DeliverGateStrategyV1
}

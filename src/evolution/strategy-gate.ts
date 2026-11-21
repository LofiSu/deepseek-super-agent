import type { DeliverGateStrategyV1 } from './types.ts'
import type { GateReport } from '../speculate/gate.ts'
import type { Ticket } from '../shared/types.ts'
import { compileBoundedPattern, tokensToBoundedPattern, assertSafeToken, MAX_TOKENS_PER_SIDE } from './safe-pattern.ts'

function patternsFor(strategy: DeliverGateStrategyV1): { negative: RegExp; positive: RegExp } {
  let negativePattern: string
  let positivePattern: string
  if (strategy.positiveTokens?.length && strategy.negativeTokens?.length) {
    positivePattern = tokensToBoundedPattern(strategy.positiveTokens)
    negativePattern = tokensToBoundedPattern(strategy.negativeTokens)
  } else if (strategy.positivePattern && strategy.negativePattern) {
    negativePattern = strategy.negativePattern
    positivePattern = strategy.positivePattern
    compileBoundedPattern(negativePattern)
    compileBoundedPattern(positivePattern)
  } else {
    throw new Error('strategy needs token lists or bounded patterns')
  }
  return {
    negative: compileBoundedPattern(negativePattern),
    positive: compileBoundedPattern(positivePattern),
  }
}

function valuableText(strategy: DeliverGateStrategyV1, text: string): boolean {
  const { negative, positive } = patternsFor(strategy)
  const bounded = text.slice(0, 8_192)
  const clauses = bounded.split(/[.;!?\n]+/).map(clause => clause.trim()).filter(Boolean)
  let sawPositive = false
  for (const clause of clauses) {
    if (negative.test(clause)) return strategy.clauseLocalPositive ? sawPositive : false
    if (positive.test(clause)) sawPositive = true
  }
  return sawPositive
}

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

const ALLOWED_KEYS = new Set([
  'schemaVersion', 'domain', 'positiveTokens', 'negativeTokens',
  'negativePattern', 'positivePattern', 'clauseLocalPositive',
])

export function parseDeliverGateStrategy(raw: unknown): DeliverGateStrategyV1 {
  if (!raw || typeof raw !== 'object') throw new Error('strategy must be an object')
  const obj = raw as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`unknown strategy key: ${key}`)
  }
  if (obj.schemaVersion !== 1 && obj.schemaVersion !== 2) {
    throw new Error(`unsupported strategy schemaVersion ${obj.schemaVersion}`)
  }
  if (obj.domain !== 'deliver-gate-v1') throw new Error(`unsupported strategy domain ${obj.domain}`)
  if (typeof obj.clauseLocalPositive !== 'boolean') throw new Error('clauseLocalPositive must be boolean')

  if (Array.isArray(obj.positiveTokens) && Array.isArray(obj.negativeTokens)) {
    if (obj.positiveTokens.length > MAX_TOKENS_PER_SIDE || obj.negativeTokens.length > MAX_TOKENS_PER_SIDE) {
      throw new Error('too many tokens')
    }
    for (const token of [...obj.positiveTokens, ...obj.negativeTokens]) {
      if (typeof token !== 'string') throw new Error('token must be string')
      assertSafeToken(token, 'token')
    }
    tokensToBoundedPattern(obj.positiveTokens as string[])
    tokensToBoundedPattern(obj.negativeTokens as string[])
    return obj as unknown as DeliverGateStrategyV1
  }

  if (typeof obj.negativePattern === 'string' && typeof obj.positivePattern === 'string') {
    compileBoundedPattern(obj.negativePattern)
    compileBoundedPattern(obj.positivePattern)
    return obj as unknown as DeliverGateStrategyV1
  }
  throw new Error('positiveTokens/negativeTokens required for v2')
}

export function strategyTokens(strategy: DeliverGateStrategyV1): {
  positiveTokens: string[]
  negativeTokens: string[]
} {
  if (strategy.positiveTokens?.length && strategy.negativeTokens?.length) {
    return {
      positiveTokens: strategy.positiveTokens.map(t => t.trim().toLowerCase()),
      negativeTokens: strategy.negativeTokens.map(t => t.trim().toLowerCase()),
    }
  }
  throw new Error('strategy missing token lists')
}

import { loadPromotedStrategy } from '../evolution/promotion.ts'
import { ConfigurableDeliverGate } from './configurable-gate.ts'
import { HeuristicDeliverGate, type DeliverGate } from './gate.ts'

/**
 * Opt-in: set DS_AGENT_USE_PROMOTED_DELIVER_GATE=1 and approve evolution artifact
 * under <home>/evolution/deliver-gate.strategy.json.
 */
export function resolveDeliverGate(home: string, env: NodeJS.ProcessEnv = process.env): DeliverGate {
  if (env.DS_AGENT_USE_PROMOTED_DELIVER_GATE !== '1') return new HeuristicDeliverGate()
  const strategy = loadPromotedStrategy(home)
  if (!strategy) return new HeuristicDeliverGate()
  return new ConfigurableDeliverGate(strategy)
}

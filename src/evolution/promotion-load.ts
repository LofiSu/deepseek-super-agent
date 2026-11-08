import fs from 'node:fs'
import path from 'node:path'
import { parseDeliverGateStrategy } from './strategy-gate.ts'
import type { DeliverGateStrategyV1 } from './types.ts'

export function loadPromotedStrategy(home: string): DeliverGateStrategyV1 | null {
  const file = path.join(home, 'evolution', 'deliver-gate.strategy.json')
  if (!fs.existsSync(file)) return null
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  return parseDeliverGateStrategy(raw)
}

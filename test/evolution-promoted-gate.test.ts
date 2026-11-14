import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeSynthDataset } from '../src/evolution/synth-fixture.ts'
import { runEvolution } from '../src/evolution/evolve.ts'
import { freezeCandidate } from '../src/evolution/experiment.ts'
import { runFinalTestOnce } from '../src/evolution/finalize.ts'
import { approvePromotion, rollbackPromotion } from '../src/evolution/promotion.ts'
import { resolveDeliverGate } from '../src/speculate/resolve-gate.ts'
import { HeuristicDeliverGate } from '../src/speculate/gate.ts'
import { ConfigurableDeliverGate } from '../src/speculate/configurable-gate.ts'
import { defaultBaselineStrategy } from '../src/evolution/dataset.ts'
import { evaluateDeliverGateStrategy } from '../src/evolution/strategy-gate.ts'
import type { Ticket } from '../src/shared/types.ts'
import type { GateReport } from '../src/speculate/gate.ts'

const gateTicket = { speculative: true } as Ticket

const homes: string[] = []
const datasets: string[] = []

afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true })
  for (const d of datasets.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('promoted deliver gate consumer', () => {
  it('orbit-only strategy delivers on orbit report; rollback restores heuristic discard', async () => {
    const datasetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-gate-ds-'))
    datasets.push(datasetRoot)
    writeSynthDataset(datasetRoot)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-gate-home-'))
    homes.push(home)
    const budget = { maxCandidates: 4, maxEvals: 32, evalTimeoutMs: 20_000, reserveEvals: 4, maxCandidatesThisRun: 1 }

    await runEvolution({
      home,
      datasetRoot,
      selector: 'simplified-greedy',
      stopOnFirstSuccess: false,
      budget,
    })
    const r2 = await runEvolution({
      home,
      datasetRoot,
      round: 2,
      selector: 'policy-memory',
      budget,
    })
    const winner = r2.candidates.find(c => c.reward === 'success' && c.status === 'evaluated')
    expect(winner?.strategy.positiveTokens).toContain('orbit')

    freezeCandidate({ home, candidateId: winner!.candidateId, runId: r2.runId })
    await runFinalTestOnce({ home, datasetRoot, candidateId: winner!.candidateId })

    const orbitReport: GateReport = { kind: 'ready', text: 'orbit linkage complete for deploy.' }
    const baseline = defaultBaselineStrategy()
    expect(evaluateDeliverGateStrategy(baseline, { speculative: true, report: orbitReport })).toBe('discard')
    expect(evaluateDeliverGateStrategy(winner!.strategy, { speculative: true, report: orbitReport })).toBe('deliver')

    const prev = process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE
    process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE = '1'
    process.env.DS_AGENT_HOME = home
    try {
      const baselineGate = new HeuristicDeliverGate()
      expect(baselineGate.evaluate({ ticket: gateTicket, report: orbitReport })).toBe('discard')

      approvePromotion({
        home,
        runReport: r2,
        candidateId: winner!.candidateId,
        artifactPath: path.join(r2.archiveDir, winner!.candidateId, 'candidate.json'),
      })
      const promoted = resolveDeliverGate(home)
      expect(promoted).toBeInstanceOf(ConfigurableDeliverGate)
      expect(promoted.evaluate({ ticket: gateTicket, report: orbitReport })).toBe('deliver')

      rollbackPromotion(home)
      const after = resolveDeliverGate(home)
      expect(after).toBeInstanceOf(HeuristicDeliverGate)
      expect(after.evaluate({ ticket: gateTicket, report: orbitReport })).toBe('discard')
    } finally {
      if (prev === undefined) delete process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE
      else process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE = prev
    }
  })
})

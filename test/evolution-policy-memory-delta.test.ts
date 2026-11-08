import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultBaselineStrategy } from '../src/evolution/dataset.ts'
import {
  emptyCarrier,
  loadPolicyMemory,
  strategyTokenDelta,
  updatePolicyMemoryFromRound,
} from '../src/evolution/policy-memory.ts'
import { stableJsonDigest } from '../src/evolution/digest.ts'
import type { EvolutionCandidateRecord } from '../src/evolution/types.ts'
import { BASELINE_PARENT_ID } from '../src/evolution/experiment.ts'
import { EVOLUTION_SCHEMA_VERSION, DELIVER_GATE_DOMAIN } from '../src/evolution/types.ts'

describe('policy memory parent→child delta', () => {
  const homes: string[] = []
  afterEach(() => {
    for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true })
  })

  it('stores added token from delta not baseline ready/fixed', () => {
    const parent = defaultBaselineStrategy()
    const child = {
      ...parent,
      positiveTokens: [...parent.positiveTokens!, 'widget'],
    }
    const delta = strategyTokenDelta(parent, child)
    expect(delta.addedPositive).toEqual(['widget'])

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-mem-'))
    homes.push(home)
    const experimentId = 'exp_test'
    const strategyDigest = stableJsonDigest(child)
    const record: EvolutionCandidateRecord = {
      candidateId: 'cand_widget',
      parentId: BASELINE_PARENT_ID,
      directionKey: 'dir',
      lineageHash: 'lh',
      strategy: child,
      strategyDigest,
      artifactDigest: 'seal_pending',
      status: 'evaluated',
      scores: [],
      reward: 'success',
      proposedFrom: 'train_failures',
      failureCaseId: 'tr-synthetic',
      round: 1,
      createdAt: new Date().toISOString(),
    }
    updatePolicyMemoryFromRound({
      home,
      experimentId,
      round: 1,
      completed: [record],
    })
    const mem = loadPolicyMemory(home, experimentId)
    const lesson = mem.lessons.find(l => l.preferredToken === 'widget')
    expect(lesson).toBeDefined()
    expect(lesson?.targets).toEqual(['tr-synthetic'])
    expect(lesson?.preferredToken).not.toBe('ready')
  })

  it('retires active lesson on contradictory failure for same direction', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-mem2-'))
    homes.push(home)
    const experimentId = 'exp_retire'
    const parent = defaultBaselineStrategy()
    const child: import('../src/evolution/types.ts').DeliverGateStrategyV1 = {
      schemaVersion: EVOLUTION_SCHEMA_VERSION,
      domain: DELIVER_GATE_DOMAIN,
      positiveTokens: [...parent.positiveTokens!, 'alpha'],
      negativeTokens: parent.negativeTokens!,
      clauseLocalPositive: true,
    }
    const dir = 'same_dir'
    const baseRecord: EvolutionCandidateRecord = {
      candidateId: 'cand_ok',
      parentId: BASELINE_PARENT_ID,
      directionKey: dir,
      lineageHash: 'lh1',
      strategy: child,
      strategyDigest: stableJsonDigest(child),
      artifactDigest: 'a',
      status: 'evaluated',
      scores: [],
      reward: 'success',
      proposedFrom: 'train_failures',
      failureCaseId: 'tr-1',
      round: 1,
      createdAt: new Date().toISOString(),
    }
    updatePolicyMemoryFromRound({ home, experimentId, round: 1, completed: [baseRecord] })
    const failChild = { ...child, positiveTokens: [...child.positiveTokens!, 'beta'] }
    const failRecord: EvolutionCandidateRecord = {
      ...baseRecord,
      candidateId: 'cand_fail',
      strategy: failChild,
      strategyDigest: stableJsonDigest(failChild),
      reward: 'failure',
      round: 2,
    }
    updatePolicyMemoryFromRound({ home, experimentId, round: 2, completed: [failRecord] })
    const mem = loadPolicyMemory(home, experimentId)
    const retired = mem.lessons.filter(l => l.directionKey === dir && l.status === 'retired')
    expect(retired.length).toBeGreaterThan(0)
    expect(emptyCarrier(experimentId, 0).lessons).toHaveLength(0)
  })
})

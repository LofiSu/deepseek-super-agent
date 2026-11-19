import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultBaselineStrategy } from '../src/evolution/dataset.ts'
import {
  applyMemoryLessons,
  emptyCarrier,
  loadPolicyMemory,
  strategyTokenDelta,
  updatePolicyMemoryFromRound,
  validatePolicyMemoryCarrier,
} from '../src/evolution/policy-memory.ts'
import {
  collectRetiredFailureIds,
  selectFailureCasePolicyMemory,
} from '../src/evolution/search-selector.ts'
import { TrainFailureProposer } from '../src/evolution/train-proposer.ts'
import { stableJsonDigest } from '../src/evolution/digest.ts'
import type { EvolutionCandidateRecord, EvolutionEvalCase } from '../src/evolution/types.ts'
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

describe('policy memory targets bind legal custom case ids', () => {
  const homes: string[] = []
  afterEach(() => {
    for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true })
  })

  function caseOf(id: string, text: string): EvolutionEvalCase {
    return {
      id,
      speculative: true,
      report: { kind: 'ready', text },
      expected: 'deliver',
    }
  }

  function orbitMemory(): ReturnType<typeof emptyCarrier> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-mem-custom-'))
    homes.push(home)
    const experimentId = 'exp_custom'
    const parent = defaultBaselineStrategy()
    const child = {
      ...parent,
      positiveTokens: [...parent.positiveTokens!, 'orbit'],
    }
    const record: EvolutionCandidateRecord = {
      candidateId: 'cand_orbit',
      parentId: BASELINE_PARENT_ID,
      directionKey: 'dir_orbit',
      lineageHash: 'lh',
      strategy: child,
      strategyDigest: stableJsonDigest(child),
      artifactDigest: 'seal_pending',
      status: 'evaluated',
      scores: [],
      reward: 'success',
      proposedFrom: 'train_failures',
      failureCaseId: 'none-task',
      round: 1,
      createdAt: new Date().toISOString(),
    }
    updatePolicyMemoryFromRound({ home, experimentId, round: 1, completed: [record] })
    return loadPolicyMemory(home, experimentId)
  }

  it('stores a custom case id as the single lesson target', () => {
    const memory = orbitMemory()
    const lesson = memory.lessons.find(l => l.preferredToken === 'orbit')
    expect(lesson).toBeDefined()
    expect(lesson?.targets).toEqual(['none-task'])
  })

  it('applies the lesson to its source arm only', () => {
    const memory = orbitMemory()
    const parent = defaultBaselineStrategy()
    const positive = [...parent.positiveTokens!]
    const negative = [...parent.negativeTokens!]
    expect(applyMemoryLessons(memory, 'none-task', positive, negative)).toEqual({
      token: 'orbit',
      side: 'positive',
    })
    expect(applyMemoryLessons(memory, 'glimmer-case', positive, negative)).toBeNull()
  })

  it('selects the lesson source arm instead of the first viable arm', () => {
    const memory = orbitMemory()
    const pick = selectFailureCasePolicyMemory({
      trainFailures: [
        caseOf('glimmer-case', 'glimmer linkage complete for deploy.'),
        caseOf('none-task', 'orbit linkage complete for deploy.'),
      ],
      memory,
      seenDirections: new Set(),
      retiredFailureIds: new Set(),
      opportunity: 1,
      seed: 1,
    })
    expect(pick).toBe('none-task')
  })

  it('does not leak the source token into an unrelated proposal', () => {
    const memory = orbitMemory()
    const parent = defaultBaselineStrategy()
    const next = new TrainFailureProposer(true).propose({
      baseline: parent,
      parentStrategy: parent,
      trainFailures: [
        caseOf('glimmer-case', 'glimmer linkage complete for deploy.'),
        caseOf('none-task', 'orbit linkage complete for deploy.'),
      ],
      memory,
      seed: 1,
      failureCaseId: 'glimmer-case',
      seenDirections: new Set(),
      useMemory: true,
    })
    expect(next?.positiveTokens).toContain('glimmer')
    expect(next?.positiveTokens).not.toContain('orbit')
  })

  it('retires a custom failure arm from a retired lesson target', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-mem-custom-retire-'))
    homes.push(home)
    const experimentId = 'exp_custom_retire'
    const parent = defaultBaselineStrategy()
    const child = { ...parent, positiveTokens: [...parent.positiveTokens!, 'orbit'] }
    const record: EvolutionCandidateRecord = {
      candidateId: 'cand_fail',
      parentId: BASELINE_PARENT_ID,
      directionKey: 'dir_bad',
      lineageHash: 'lh',
      strategy: child,
      strategyDigest: stableJsonDigest(child),
      artifactDigest: 'seal_pending',
      status: 'evaluated',
      scores: [],
      reward: 'failure',
      proposedFrom: 'train_failures',
      failureCaseId: 'none-task',
      round: 1,
      createdAt: new Date().toISOString(),
    }
    updatePolicyMemoryFromRound({ home, experimentId, round: 1, completed: [record] })
    const memory = loadPolicyMemory(home, experimentId)
    expect([...collectRetiredFailureIds(memory)]).toContain('none-task')
  })
})

describe('validatePolicyMemoryCarrier target ids', () => {
  function carrierWithTarget(target: string): ReturnType<typeof emptyCarrier> {
    const carrier = emptyCarrier('exp', 1)
    carrier.lessons.push({
      id: 'l',
      appliesWhen: 'x',
      mechanismHypothesis: 'x',
      recommendedChange: 'x',
      targets: [target],
      sources: ['cand_1'],
      status: 'active',
    })
    return carrier
  }

  it('accepts legal custom case ids and existing train/validation ids', () => {
    for (const target of ['none-task', 'glimmer-case', 't-unique', ' none', 'tr-x', 'va-y']) {
      expect(() => validatePolicyMemoryCarrier(carrierWithTarget(target))).not.toThrow()
    }
  })

  it('rejects the reserved sentinel, final-test ids, and blank ids', () => {
    for (const target of ['none', 'ho-001', 'ft-001', 'FT-1', '', '   ']) {
      expect(() => validatePolicyMemoryCarrier(carrierWithTarget(target))).toThrow()
    }
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bernoulliKl, klUcbMaxq, klUcbSelect } from '../src/evolution/kl-ucb.ts'
import { loadSearchDatasetOnly } from '../src/evolution/dataset.ts'
import { TrainFailureProposer } from '../src/evolution/train-proposer.ts'
import { emptyCarrier, validatePolicyMemoryCarrier } from '../src/evolution/policy-memory.ts'
import { defaultBaselineStrategy } from '../src/evolution/dataset.ts'
import { loadPromotedStrategy } from '../src/evolution/promotion-load.ts'
import { writeJsonAtomic } from '../src/evolution/io.ts'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const datasetRoot = path.join(repoRoot, 'test/fixtures/evolution')

describe('regression: reviewer blockers (PR168)', () => {
  describe('A KL-UCB', () => {
    it('p=0 q=1 KL is Infinity', () => {
      expect(bernoulliKl(0, 1)).toBe(Infinity)
    })

    it('s=0 n=1 T=1 c=0 yields index 0.5 (not 0)', () => {
      const index = klUcbMaxq(0, 1, 1, 0)
      expect(index).toBeCloseTo(0.5, 5)
    })

    it('invalid trials fail closed', () => {
      expect(() => klUcbMaxq(0, -1, 1, 0)).toThrow()
      expect(() => klUcbMaxq(Number.NaN, 1, 1, 0)).toThrow()
    })

    it('empty arms throws', () => {
      expect(() => klUcbSelect([], 1, 1, 42)).toThrow()
    })

    it('after arm0 fails, arm1 is selected (seeded)', () => {
      const arms = [
        { id: 'fail_0', observations: [{ id: 'obs0', reward: 0 as const }] },
        { id: 'fail_1', observations: [] as { id: string; reward: 0 | 1; skip?: boolean }[] },
      ]
      expect(klUcbSelect(arms, 2, 1, 99)).toBe('fail_1')
    })
  })

  describe('B proposer / memory', () => {
    it('does not hardcode checkout when lesson names another token', () => {
      const baseline = defaultBaselineStrategy()
      const trainFailures = [{
        id: 'tr-x',
        speculative: true,
        report: { kind: 'ready', text: 'widget relay stabilized.' },
        expected: 'deliver' as const,
      }]
      const memory = emptyCarrier('exp', 2)
      memory.lessons.push({
        id: 'lesson_prior',
        appliesWhen: 'train miss',
        mechanismHypothesis: 'missing token',
        recommendedChange: 'add positive token widget',
        preferredToken: 'widget',
        targets: ['tr-x'],
        sources: ['cand_old'],
        status: 'active',
      })
      const proposer = new TrainFailureProposer()
      const next = proposer.propose({
        baseline,
        parentStrategy: baseline,
        trainFailures,
        memory,
        seed: 1,
        failureCaseId: 'tr-x',
        seenDirections: new Set(),
      })
      expect(next?.positiveTokens).toContain('widget')
      expect(next?.positiveTokens).not.toContain('checkout')
    })

    it('rejects finaltest case ids in memory sources structurally', () => {
      const carrier = emptyCarrier('exp', 1)
      carrier.lessons.push({
        id: 'bad',
        appliesWhen: 'x',
        mechanismHypothesis: 'x',
        recommendedChange: 'x',
        targets: [],
        sources: ['ho-001'],
        status: 'active',
      })
      expect(() => validatePolicyMemoryCarrier(carrier)).toThrow()
    })
  })

  describe('C search never reads finaltest bytes', () => {
    it('loadSearchDatasetOnly does not open finaltest.json', () => {
      const realRead = fs.readFileSync.bind(fs)
      const calls: string[] = []
      const spy = fs.readFileSync as typeof fs.readFileSync
      ;(fs as { readFileSync: typeof fs.readFileSync }).readFileSync = ((
        p: fs.PathOrFileDescriptor,
        options?: Parameters<typeof fs.readFileSync>[1],
      ) => {
        calls.push(String(p))
        return options === undefined ? realRead(p) : realRead(p, options)
      }) as typeof fs.readFileSync
      try {
        const data = loadSearchDatasetOnly(datasetRoot)
        expect(data.train.length).toBeGreaterThan(0)
        expect(calls.some(c => c.endsWith('finaltest.json'))).toBe(false)
      } finally {
        fs.readFileSync = spy
      }
    })
  })

  describe('E consumer promotion binding', () => {
    const homes: string[] = []
    afterEach(() => {
      for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true })
    })

    it('orphan strategy file does not activate without promotion.json', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-orphan-'))
      homes.push(home)
      const strategy = defaultBaselineStrategy()
      writeJsonAtomic(path.join(home, 'evolution', 'deliver-gate.strategy.json'), strategy)
      expect(loadPromotedStrategy(home)).toBeNull()
    })
  })
})

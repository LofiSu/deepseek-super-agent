import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { HttpOpenAI, MockModel } from '../src/harness/model.ts'
import { ruleClassify } from '../src/ingress/filter.ts'
import type { Trigger } from '../src/shared/types.ts'

/**
 * P2-4: the shipped Slow Path is the deterministic rule classifier. This test
 * pins that both model implementations delegate to `ruleClassify`, synchronously
 * and without touching the network. No model-backed policy classifier is wired.
 */

/** Representative triggers: action+mention, action only, mention only, noise, short text, speculate hint. */
function cases(): Array<{ label: string; trigger: Trigger }> {
  const base = (input: { text: string; addressed?: boolean; speculate?: boolean }): Trigger => {
    const trigger = imTrigger({
      id: `trg_p24_${input.text.length}`,
      thread: 'topic/slow-path',
      text: input.text,
      addressed: input.addressed === false ? false : undefined,
    })
    return input.speculate === true ? { ...trigger, speculate: true } : trigger
  }
  return [
    {
      label: 'action + mention',
      trigger: base({ text: '@ds-agent please fix the login timeout' }),
    },
    {
      label: 'action only',
      trigger: base({ text: 'CI failed on auth test', addressed: false }),
    },
    {
      label: 'mention only',
      trigger: base({ text: '@ds-agent sharing the notes from standup', addressed: false }),
    },
    {
      label: 'noise',
      trigger: base({ text: 'lol nice weather today haha', addressed: false }),
    },
    {
      label: 'short text',
      trigger: base({ text: 'ok', addressed: false }),
    },
    {
      label: 'speculate hint',
      trigger: base({
        text: 'maybe we should revisit the rollout approach later',
        addressed: false,
        speculate: true,
      }),
    },
  ]
}

describe('slow-path policy classifier (P2-4)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // An unreachable base plus a throwing fetch: any network use fails loudly.
    fetchSpy = vi.fn(() => {
      throw new Error('slow-path classifier must not call fetch')
    })
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('HttpOpenAI.classify equals ruleClassify for every trigger and never fetches', () => {
    const model = new HttpOpenAI('http://127.0.0.1:1/v1', 'fake-key', 'fake-model', 1000)
    for (const { label, trigger } of cases()) {
      expect(model.classify(trigger), label).toEqual(ruleClassify(trigger))
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('MockModel.classify equals ruleClassify for every trigger', () => {
    const model = new MockModel()
    for (const { label, trigger } of cases()) {
      expect(model.classify(trigger), label).toEqual(ruleClassify(trigger))
    }
  })

  it('classifies synchronously: no timer or microtask is needed', () => {
    const model = new HttpOpenAI('http://127.0.0.1:1/v1', 'fake-key', 'fake-model', 1000)
    for (const { trigger } of cases()) {
      const hit = model.classify(trigger)
      expect(typeof hit.pass).toBe('boolean')
      expect(hit.strength).toMatch(/^(explicit|inferred|maybe)$/)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

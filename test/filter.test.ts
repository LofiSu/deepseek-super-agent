import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { createModelFromEnv, requireLiveModelFromEnv, MockModel } from '../src/harness/model.ts'
import { resolveLiveApi } from '../src/harness/providers.ts'
import { fastPath, filterTrigger, ruleClassify } from '../src/ingress/filter.ts'
import type { Runtime } from '../src/runtime.ts'
import { freshRuntime, shutdown } from './fixtures.ts'

const model = new MockModel()
let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

describe('two-level filter', () => {
  it('drops obvious noise on the fast path', () => {
    const trigger = imTrigger({
      id: 'n1',
      thread: 'topic/chatter',
      text: 'lol nice weather today haha',
      addressed: false,
    })
    expect(fastPath(trigger).pass).toBe(false)
    const verdict = filterTrigger(trigger, model)
    expect(verdict.action).toBe('drop')
    expect(verdict.layer).toBe('fast')
  })

  it('lets a long aimless note past the fast path and drops it semantically', () => {
    const trigger = imTrigger({
      id: 'n2',
      thread: 'topic/chatter',
      text: 'circling back on the notes from yesterday standup, sharing for visibility only',
      addressed: false,
    })
    expect(fastPath(trigger)).toEqual({ pass: true, reason: 'observed' })
    expect(ruleClassify(trigger).pass).toBe(false)
    const verdict = filterTrigger(trigger, model)
    expect(verdict.action).toBe('drop')
    expect(verdict.layer).toBe('semantic')
    expect(verdict.reason).toBe('no-intent')
  })

  it('passes an explicit mention and an inferred CI failure', () => {
    const mention = imTrigger({
      id: 'ok',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout',
    })
    expect(filterTrigger(mention, model)).toMatchObject({ action: 'pass', strength: 'explicit', layer: 'semantic' })
    const ci = filterTrigger({
      id: 'ci',
      source: 'github',
      threads: [{ source: 'github', id: 'pr/42' }],
      actor: { source: 'github', id: 'ci-bot' },
      human: false,
      at: '2026-10-31T00:00:00.000Z',
      text: 'CI failed on auth test',
      meta: { pr: 42 },
    }, model)
    expect(ci).toMatchObject({ action: 'pass', strength: 'inferred' })
  })

  it('rejects an unknown source and records noise through the engine', () => {
    const email = filterTrigger({
      id: 'mail',
      source: 'email',
      threads: [{ source: 'email', id: 'inbox' }],
      actor: { source: 'email', id: 'a' },
      human: true,
      at: '2026-10-31T00:00:00.000Z',
      text: '@ds-agent please fix the login timeout',
      meta: {},
    }, model)
    expect(email.layer).toBe('fast')
    expect(email.reason).toBe('source-not-allowlisted')

    runtime = freshRuntime({ model })
    const noise = runtime.ingest(imTrigger({
      id: 'trg_noise',
      thread: 'topic/chatter',
      text: 'lol nice weather today haha',
      addressed: false,
    }))
    const soft = runtime.ingest(imTrigger({
      id: 'trg_soft',
      thread: 'topic/chatter',
      text: 'circling back on the notes from yesterday standup, sharing for visibility only',
      addressed: false,
    }))
    expect(noise).toBe('filtered')
    expect(soft).toBe('filtered')
    expect(runtime.ingest(imTrigger({
      id: 'trg_noise',
      thread: 'topic/chatter',
      text: 'lol nice weather today haha',
      addressed: false,
    }))).toBe('duplicate')
    const text = runtime.log.text()
    expect(text).toContain('noise dropped')
    expect(text).toContain('layer=fast')
    expect(text).toContain('layer=semantic')
    expect(text).toContain('Intake.receive')
  })

  it('uses HttpOpenAI when DS_AGENT_API_BASE and DS_AGENT_API_KEY are both set', () => {
    expect(createModelFromEnv({}).name).toBe('MockModel')
    expect(createModelFromEnv({ DS_AGENT_API_BASE: 'http://127.0.0.1:9/v1', DS_AGENT_API_KEY: 'test' }).name).toBe('HttpOpenAI')
  })

  it('resolves DEEPSEEK_API_KEY / OPENROUTER / OPENAI / GROK without Mock', () => {
    expect(resolveLiveApi({})).toBeNull()
    expect(resolveLiveApi({ DEEPSEEK_API_KEY: 'k' })?.base).toContain('deepseek.com')
    expect(resolveLiveApi({ OPENROUTER_API_KEY: 'k' })?.model).toContain('deepseek')
    expect(resolveLiveApi({ OPENAI_API_KEY: 'k' })?.provider).toBe('openai')
    expect(resolveLiveApi({ GROK_API_KEY: 'k' })?.provider).toBe('xai')
    expect(() => requireLiveModelFromEnv({})).toThrow(/refusing MockModel/)
    expect(requireLiveModelFromEnv({ DEEPSEEK_API_KEY: 'k' }).name).toBe('HttpOpenAI')
  })
})

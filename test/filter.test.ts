import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { createModelFromEnv, requireLiveModelFromEnv, resolveLiveApi, MockModel } from '../src/harness/model.ts'
import { fastPath, filterTrigger, ruleClassify } from '../src/ingress/filter.ts'
import { clearSlowPathCache, SLOW_PATH_POLICY, slowPath, slowPathStats } from '../src/ingress/slow-path.ts'
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
    expect(verdict.path).toBe('slow-reject')
    expect(verdict.policy).toBe('rules')
    expect(verdict.signals).toContain('no-intent')
  })

  it('lets a mention outrank noise and an action outrank a noise token', () => {
    const mentioned = imTrigger({
      id: 'n3',
      thread: 'topic/chatter',
      text: 'lol nice weather today haha',
    })
    expect(filterTrigger(mentioned, model)).toMatchObject({
      action: 'pass',
      strength: 'explicit',
      path: 'slow-admit',
      signals: ['mention', 'noise'],
    })
    const noisyFix = imTrigger({
      id: 'n4',
      thread: 'topic/chatter',
      text: 'lol the build failed overnight',
      addressed: false,
    })
    expect(filterTrigger(noisyFix, model)).toMatchObject({
      action: 'pass',
      strength: 'inferred',
      path: 'slow-admit',
      signals: ['action', 'noise'],
    })
  })

  it('vetoes bot echoes, empty text, and optional group or actor lists on the fast path', () => {
    const echo = imTrigger({
      id: 'self',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout',
      actor: 'ds-agent',
    })
    expect(fastPath(echo)).toEqual({ pass: false, reason: 'bot-self' })
    const veto = filterTrigger(echo, model)
    expect(veto.path).toBe('fast-veto')
    expect(veto.layer).toBe('fast')
    expect(veto.semantic.startsWith('pass:')).toBe(true)

    expect(fastPath(imTrigger({
      id: 'empty',
      thread: 'topic/chatter',
      text: '   ',
      addressed: false,
    })).reason).toBe('empty')

    const outsider = imTrigger({
      id: 'group',
      thread: 'topic/room',
      text: 'hello from another room today',
      addressed: false,
      actor: 'sam',
    })
    outsider.meta = { group: 'random' }
    expect(fastPath(outsider, { groups: ['eng'] })).toEqual({ pass: false, reason: 'group-not-allowlisted' })
    outsider.meta = { group: 'eng' }
    expect(fastPath(outsider, { groups: ['eng'] }).reason).toBe('observed')
    expect(fastPath(imTrigger({
      id: 'actor',
      thread: 'topic/room',
      text: 'hello from another room today',
      addressed: false,
      actor: 'sam',
    }), { actors: ['alex'] }).reason).toBe('actor-not-allowlisted')
    expect(fastPath(imTrigger({
      id: 'actor-mention',
      thread: 'topic/room',
      text: 'hello from another room today',
      actor: 'sam',
    }), { actors: ['alex'] }).pass).toBe(true)
  })

  it('caches an identical slow-path decision', () => {
    clearSlowPathCache()
    const trigger = imTrigger({
      id: 'cache',
      thread: 'topic/chatter',
      text: 'circling back on the notes from yesterday standup, sharing for visibility only',
      addressed: false,
    })
    expect(SLOW_PATH_POLICY).toContain('no-intent')
    expect(slowPath(trigger).reason).toBe('no-intent')
    expect(slowPath(trigger).reason).toBe('no-intent')
    expect(ruleClassify(trigger).policy).toBe('rules')
    expect(slowPathStats()).toMatchObject({ hits: 2, misses: 1 })
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

  it('uses HttpOpenAI only when both cloud env vars are set', () => {
    expect(createModelFromEnv({}).name).toBe('MockModel')
    expect(createModelFromEnv({ DS_AGENT_API_BASE: 'http://127.0.0.1:9/v1', DS_AGENT_API_KEY: 'test' }).name).toBe('HttpOpenAI')
  })

  it('resolves DEEPSEEK_API_KEY / OPENROUTER / OPENAI / GROK without Mock', () => {
    expect(resolveLiveApi({})).toBeNull()
    expect(resolveLiveApi({ DEEPSEEK_API_KEY: 'k' })?.base).toContain('deepseek.com')
    expect(resolveLiveApi({ OPENROUTER_API_KEY: 'k' })?.model).toContain('deepseek')
    expect(resolveLiveApi({ OPENAI_API_KEY: 'k' })?.source).toBe('OPENAI_API_KEY')
    expect(resolveLiveApi({ GROK_API_KEY: 'k' })?.source).toBe('GROK_API_KEY')
    expect(() => requireLiveModelFromEnv({})).toThrow(/requires a real model API key/)
    expect(requireLiveModelFromEnv({ DEEPSEEK_API_KEY: 'k' }).name).toBe('HttpOpenAI')
  })
})

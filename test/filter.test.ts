import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { createModelFromEnv, requireLiveModelFromEnv, type Model } from '../src/harness/model.ts'
import { resolveLiveApi } from '../src/harness/providers.ts'
import { fastPath, filterTrigger, ruleClassify } from '../src/ingress/filter.ts'
import type { Runtime } from '../src/runtime.ts'
import { freshRuntime, shutdown } from './fixtures.ts'

/** Semantic-only stand-in: classify via rules; complete is unused by filterTrigger. */
const semanticOnly: Model = {
  name: 'RuleSemantic',
  classify: trigger => ruleClassify(trigger),
  async complete() {
    return { text: '' }
  },
}

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

/** IM trigger with an explicit channel address; `group` is absent when omitted. */
function groupTrigger(input: {
  id: string
  group?: string
  actor?: string
  text?: string
  meta?: Record<string, unknown>
}) {
  const base = imTrigger({
    id: input.id,
    thread: 'chat/eng',
    actor: input.actor ?? 'alex',
    text: input.text ?? '@ds-agent please fix the login timeout',
  })
  return {
    ...base,
    channel: {
      source: 'im',
      thread: 'chat/eng',
      ...(input.group ? { address: { group: input.group } } : {}),
    },
    meta: input.meta ?? {},
  }
}

describe('two-level filter', () => {
  it('drops obvious noise on the fast path', () => {
    const trigger = imTrigger({
      id: 'n1',
      thread: 'topic/chatter',
      text: 'lol nice weather today haha',
      addressed: false,
    })
    expect(fastPath(trigger).pass).toBe(false)
    const verdict = filterTrigger(trigger, semanticOnly)
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
    const verdict = filterTrigger(trigger, semanticOnly)
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
    expect(filterTrigger(mention, semanticOnly)).toMatchObject({ action: 'pass', strength: 'explicit', layer: 'semantic' })
    const ci = filterTrigger({
      id: 'ci',
      source: 'github',
      threads: [{ source: 'github', id: 'pr/42' }],
      actor: { source: 'github', id: 'ci-bot' },
      human: false,
      at: '2026-10-31T00:00:00.000Z',
      text: 'CI failed on auth test',
      meta: { pr: 42 },
    }, semanticOnly)
    expect(ci).toMatchObject({ action: 'pass', strength: 'inferred' })
  })

  it('rejects an unknown source and records noise through the engine', async () => {
    const email = filterTrigger({
      id: 'mail',
      source: 'email',
      threads: [{ source: 'email', id: 'inbox' }],
      actor: { source: 'email', id: 'a' },
      human: true,
      at: '2026-10-31T00:00:00.000Z',
      text: '@ds-agent please fix the login timeout',
      meta: {},
    }, semanticOnly)
    expect(email.layer).toBe('fast')
    expect(email.reason).toBe('source-not-allowlisted')

    runtime = freshRuntime()
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

  it('keeps admission unchanged when no rules are configured', () => {
    const trigger = imTrigger({
      id: 'admit-unset',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout',
    })
    expect(fastPath(trigger)).toEqual({ pass: true, reason: 'mention-or-direct' })
    expect(fastPath(trigger, {})).toEqual({ pass: true, reason: 'mention-or-direct' })
    expect(fastPath(trigger, { actors: [] })).toEqual({ pass: true, reason: 'mention-or-direct' })
  })

  it('uses HttpOpenAI when DS_AGENT_API_BASE and DS_AGENT_API_KEY are both set', () => {
    expect(createModelFromEnv({})).toMatchObject({ name: expect.stringMatching(/MockModel|HttpOpenAI/) })
    // Empty explicit env still allows Mock via createModelFromEnv; demo/fixtures refuse it.
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

describe('admission rules (T16)', () => {
  it('drops a non-allowlisted actor even on an explicit mention and keyword', () => {
    const trigger = imTrigger({
      id: 'actor-alex',
      thread: 'topic/bug-login',
      actor: 'alex',
      text: '@ds-agent please fix the login timeout',
    })
    expect(fastPath(trigger, { actors: ['bob'] }))
      .toEqual({ pass: false, reason: 'actor-not-allowlisted' })
    expect(filterTrigger(trigger, semanticOnly, { actors: ['bob'] }))
      .toMatchObject({ action: 'drop', layer: 'fast', reason: 'actor-not-allowlisted' })
    expect(filterTrigger(imTrigger({
      id: 'actor-bob',
      thread: 'topic/bug-login',
      actor: 'bob',
      text: '@ds-agent please fix the login timeout',
    }), semanticOnly, { actors: ['bob'] }).action).toBe('pass')
  })

  it('always drops the daemon actor, even when it is also allowlisted', () => {
    const self = imTrigger({
      id: 'self',
      thread: 'topic/bug-login',
      actor: 'ds-agent-bot',
      text: '@ds-agent please fix the login timeout',
    })
    expect(filterTrigger(self, semanticOnly, {
      actors: ['ds-agent-bot'],
      dropSelf: ['ds-agent-bot'],
    })).toMatchObject({ action: 'drop', layer: 'fast', reason: 'self-drop' })
  })

  it('admits only channel-address groups and ignores groups spoofed via meta', () => {
    expect(filterTrigger(groupTrigger({ id: 'group-ok', group: 'eng' }), semanticOnly, {
      groups: ['eng'],
    }).action).toBe('pass')

    expect(filterTrigger(groupTrigger({ id: 'group-bad', group: 'random' }), semanticOnly, {
      groups: ['eng'],
    })).toMatchObject({ action: 'drop', layer: 'fast', reason: 'group-not-allowlisted' })

    // A missing channel group is not allowed while the allowlist is active.
    expect(filterTrigger(groupTrigger({ id: 'group-missing' }), semanticOnly, {
      groups: ['eng'],
    })).toMatchObject({ action: 'drop', reason: 'group-not-allowlisted' })

    // `meta` is untrusted and can never satisfy the group rule.
    expect(filterTrigger(
      groupTrigger({ id: 'group-meta', meta: { group: 'eng' } }),
      semanticOnly,
      { groups: ['eng'] },
    )).toMatchObject({ action: 'drop', reason: 'group-not-allowlisted' })
  })

  it('wires actor/group/drop-self env into Runtime.ingest', async () => {
    runtime = freshRuntime({
      env: {
        DS_AGENT_ACTOR_ALLOWLIST: ' bob , ,',
        DS_AGENT_GROUP_ALLOWLIST: 'eng',
        DS_AGENT_DROP_SELF: 'ds-agent-bot',
      },
    })
    expect(runtime.ingest(groupTrigger({ id: 'env-alex', actor: 'alex', group: 'eng' }))).toBe('filtered')
    expect(runtime.ingest(groupTrigger({ id: 'env-bob-ok', actor: 'bob', group: 'eng' }))).toBe('stored')
    expect(runtime.ingest(groupTrigger({ id: 'env-bob-bad-group', actor: 'bob', group: 'random' }))).toBe('filtered')
    expect(runtime.ingest(groupTrigger({ id: 'env-self', actor: 'ds-agent-bot', group: 'eng' }))).toBe('filtered')
    const text = runtime.log.text()
    expect(text).toContain('[ingress] admission actors=bob groups=eng dropSelf=ds-agent-bot')
    expect(text).toContain('actor-not-allowlisted')
    expect(text).toContain('group-not-allowlisted')
    expect(text).toContain('self-drop')
  })

  it('lets explicit RuntimeOptions.admission win over env', () => {
    runtime = freshRuntime({
      env: { DS_AGENT_ACTOR_ALLOWLIST: 'bob' },
      admission: { actors: ['alex'] },
    })
    expect(runtime.ingest(groupTrigger({ id: 'override-alex', actor: 'alex' }))).toBe('stored')
    expect(runtime.ingest(groupTrigger({ id: 'override-bob', actor: 'bob' }))).toBe('filtered')
  })

  it('does not log admission or change behavior when the env is unset', () => {
    runtime = freshRuntime({ env: {} })
    expect(runtime.ingest(groupTrigger({ id: 'unset-alex', actor: 'alex' }))).toBe('stored')
    expect(runtime.log.text()).not.toContain('[ingress] admission')
  })
})

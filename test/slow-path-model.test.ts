import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { HttpOpenAI, MockModel, parsePolicyContent, type Model } from '../src/harness/model.ts'
import { ruleClassify, type SemanticHit } from '../src/ingress/filter.ts'
import {
  MAX_POLICY_REASON_LENGTH,
  PolicyClassifier,
  PolicyOutputError,
  type SemanticPolicy,
} from '../src/ingress/policy.ts'
import { Runtime, type SlowPathOptions } from '../src/runtime.ts'
import type { Disposition, Ticket, Trigger } from '../src/shared/types.ts'

/**
 * MODEL-SLOW-PATH (T17) offline tests. Every policy is injected or backed by a
 * stubbed fetch; no test uses a live model, channel, credential, or network.
 */

const runtimes: Runtime[] = []

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.daemon.stop()
    if (runtime.store.isOpen) runtime.store.close()
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function makeRuntime(
  slowPath?: SlowPathOptions,
  env: NodeJS.ProcessEnv = {},
  model: Model = new MockModel(),
): Runtime {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-slow-path-'))
  const runtime = Runtime.create({
    home,
    model,
    env,
    slowPath,
    jobDelayMs: 0,
    watchdogIntervalMs: 60_000,
    // Keep Eval out of these ingress assertions; the timer is unref'd.
    batchWindowMs: 60_000,
  })
  runtimes.push(runtime)
  return runtime
}

/** Fast path passes on the mention and the rules also pass. */
function action(id: string, text = '@ds-agent please fix the login timeout'): Trigger {
  return imTrigger({ id, thread: 'topic/slow-path', text })
}

/** Fast path passes as `observed`; the rules drop it as `no-intent`. */
function observed(id: string): Trigger {
  return imTrigger({
    id,
    thread: 'topic/slow-path',
    text: 'circling back on the notes from yesterday standup, sharing for visibility only',
    addressed: false,
  })
}

/** Obvious fast-path noise: the policy must not be consulted. */
function noise(id: string): Trigger {
  return imTrigger({
    id,
    thread: 'topic/slow-path',
    text: 'lol nice weather today haha',
    addressed: false,
  })
}

function recordingPolicy(hit: SemanticHit): { policy: SemanticPolicy; calls: Trigger[] } {
  const calls: Trigger[] = []
  return {
    calls,
    policy: {
      name: 'InjectedPolicy',
      async classifyPolicy(trigger: Trigger): Promise<SemanticHit> {
        calls.push(trigger)
        return hit
      },
    },
  }
}

function jsonResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('PolicyClassifier fallback', () => {
  it('returns the rule verdict with fallback:timeout when the policy never settles', async () => {
    const trigger = action('classifier-timeout')
    const classifier = new PolicyClassifier({
      name: 'NeverPolicy',
      classifyPolicy: () => new Promise<never>(() => undefined),
    }, 20)
    const hit = await classifier.classify(trigger)
    expect(hit).toEqual({ ...ruleClassify(trigger), reason: 'fallback:timeout' })
    expect(hit.strength).toBe(ruleClassify(trigger).strength)
  })

  it('returns fallback:error when the policy throws and never rejects', async () => {
    const trigger = action('classifier-throw')
    const classifier = new PolicyClassifier({
      name: 'ThrowingPolicy',
      async classifyPolicy() {
        throw new Error('backend unavailable')
      },
    })
    await expect(classifier.classify(trigger)).resolves
      .toEqual({ ...ruleClassify(trigger), reason: 'fallback:error' })
  })

  it('returns fallback:invalid for a structurally invalid hit and for PolicyOutputError', async () => {
    const trigger = action('classifier-invalid')
    const malformed = new PolicyClassifier({
      name: 'MalformedPolicy',
      async classifyPolicy() {
        return { pass: 'yes', strength: 'explicit', reason: 'nope' } as unknown as SemanticHit
      },
    })
    expect(await malformed.classify(trigger))
      .toEqual({ ...ruleClassify(trigger), reason: 'fallback:invalid' })

    const outputError = new PolicyClassifier({
      name: 'OutputErrorPolicy',
      async classifyPolicy(): Promise<SemanticHit> {
        throw new PolicyOutputError()
      },
    })
    expect(await outputError.classify(trigger))
      .toEqual({ ...ruleClassify(trigger), reason: 'fallback:invalid' })
  })

  it('accepts a valid policy hit unchanged', async () => {
    const classifier = new PolicyClassifier({
      name: 'PassPolicy',
      async classifyPolicy() {
        return { pass: true, strength: 'maybe', reason: 'policy-ok' }
      },
    })
    expect(await classifier.classify(action('classifier-pass')))
      .toEqual({ pass: true, strength: 'maybe', reason: 'policy-ok' })
  })

  it('strips control and bidi characters from injected policy reasons', async () => {
    const classifier = new PolicyClassifier({
      name: 'EscapePolicy',
      async classifyPolicy() {
        return {
          pass: true,
          strength: 'explicit',
          reason: '\u001b[31mred\u001b[0m\u0007‮pass',
        }
      },
    })
    const hit = await classifier.classify(action('classifier-escape'))
    expect(hit.pass).toBe(true)
    expect(hit.strength).toBe('explicit')
    expect(hit.reason).not.toMatch(/[\p{Cc}\p{Cf}]/u)
    expect(hit.reason).toContain('red')
  })
})

describe('Runtime ingestAsync with a model policy', () => {
  it('stores a model policy drop with the policy reason and creates no ticket', async () => {
    const { policy, calls } = recordingPolicy({ pass: false, strength: 'inferred', reason: 'model-drop' })
    const runtime = makeRuntime({ mode: 'model', policy })
    expect(runtime.slowPathMode).toBe('model')

    expect(await runtime.ingestAsync(action('model-drop'))).toBe('filtered')
    expect(calls).toHaveLength(1)
    const disposition = runtime.store.getDoc<Disposition>('disposition', 'model-drop')
    expect(disposition?.filtered).toBe('semantic:model-drop')
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(0)
  })

  it('admits a fast-path-observed trigger on a model pass and records trust.admission', async () => {
    const { policy } = recordingPolicy({ pass: true, strength: 'inferred', reason: 'model-pass' })
    const runtime = makeRuntime({ mode: 'model', policy })
    const receive = vi.spyOn(runtime.engine, 'receive')

    // The deterministic rules drop this trigger; only the policy pass can admit it.
    expect(ruleClassify(observed('model-pass')).pass).toBe(false)
    expect(await runtime.ingestAsync(observed('model-pass'))).toBe('stored')

    expect(receive).toHaveBeenCalledTimes(1)
    expect(receive.mock.calls[0]![1]).toMatchObject({
      admission: { listened: true, reason: 'model-pass' },
    })
    expect(runtime.store.getDoc<Trigger>('trigger', 'model-pass')).toBeDefined()
    expect(runtime.store.getDoc<Disposition>('disposition', 'model-pass')?.filtered).toBeUndefined()
  })

  it('does not let trigger.meta bypass a model drop or the fast path', async () => {
    const { policy, calls } = recordingPolicy({ pass: false, strength: 'inferred', reason: 'model-drop' })
    const runtime = makeRuntime({ mode: 'model', policy })

    const metaBypass = {
      ...observed('meta-drop'),
      meta: { admission: { listened: true, reason: 'meta' }, listened: true },
    }
    expect(await runtime.ingestAsync(metaBypass)).toBe('filtered')
    expect(runtime.store.getDoc<Disposition>('disposition', 'meta-drop')?.filtered)
      .toBe('semantic:model-drop')

    // A fast-path drop wins even with a permissive policy and a meta claim.
    const permissive = recordingPolicy({ pass: true, strength: 'explicit', reason: 'model-pass' })
    const fastRuntime = makeRuntime({ mode: 'model', policy: permissive.policy })
    expect(await fastRuntime.ingestAsync({
      ...noise('meta-fast-drop'),
      meta: { admission: { listened: true, reason: 'meta' } },
    })).toBe('filtered')
    expect(permissive.calls).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  it('never calls the policy when the fast path drops', async () => {
    const { policy, calls } = recordingPolicy({ pass: true, strength: 'explicit', reason: 'model-pass' })
    const runtime = makeRuntime({ mode: 'model', policy })
    expect(await runtime.ingestAsync(noise('fast-drop'))).toBe('filtered')
    expect(calls).toHaveLength(0)
  })

  it('honors a runtime timeout and falls back to the rule verdict', async () => {
    const runtime = makeRuntime({
      mode: 'model',
      timeoutMs: 100,
      policy: {
        name: 'NeverPolicy',
        classifyPolicy: () => new Promise<never>(() => undefined),
      },
    })
    expect(await runtime.ingestAsync(observed('runtime-timeout'))).toBe('filtered')
    expect(runtime.store.getDoc<Disposition>('disposition', 'runtime-timeout')?.filtered)
      .toBe('semantic:fallback:timeout')
  })

  it('uses the rules fallback when the policy throws', async () => {
    const runtime = makeRuntime({
      mode: 'model',
      policy: {
        name: 'ThrowingPolicy',
        async classifyPolicy(): Promise<SemanticHit> {
          throw new Error('backend down')
        },
      },
    })
    expect(await runtime.ingestAsync(observed('runtime-throw'))).toBe('filtered')
    expect(runtime.store.getDoc<Disposition>('disposition', 'runtime-throw')?.filtered)
      .toBe('semantic:fallback:error')
  })

  it('passes only redacted text to the policy', async () => {
    const sentinel = 'slow-path-secret-sentinel'
    const { policy, calls } = recordingPolicy({ pass: true, strength: 'explicit', reason: 'model-pass' })
    const runtime = makeRuntime(
      { mode: 'model', policy },
      { DS_AGENT_TEST_API_KEY: sentinel },
    )
    expect(await runtime.ingestAsync(action('redacted', `@ds-agent please fix ${sentinel} timeout`)))
      .toBe('stored')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.text).not.toContain(sentinel)
    expect(calls[0]!.text).toContain('[redacted]')
  })

  it('keeps concurrent ingestAsync calls for one id duplicate-safe', async () => {
    const runtime = makeRuntime({
      mode: 'model',
      policy: {
        name: 'DeferredPolicy',
        async classifyPolicy(): Promise<SemanticHit> {
          await new Promise(resolve => setTimeout(resolve, 5))
          return { pass: true, strength: 'inferred', reason: 'model-pass' }
        },
      },
    })
    const putSpill = vi.spyOn(runtime.store, 'putSpill')
    // Longer than INLINE_LIMIT so a non-duplicate path would spill twice.
    const trigger = action(
      'concurrent',
      `@ds-agent please fix the login timeout ${'x'.repeat(240)}`,
    )

    const results = await Promise.all([
      runtime.ingestAsync(trigger),
      runtime.ingestAsync(trigger),
    ])
    expect([...results].sort()).toEqual(['duplicate', 'stored'])
    expect(putSpill).toHaveBeenCalledTimes(1)
    expect(runtime.metrics.snapshot().counters['ingress.admit']).toBe(1)
    expect(runtime.metrics.snapshot().counters['ingress.drop']).toBe(0)
  })

  it('keeps sync ingest rules-only in model mode and says so once', async () => {
    const { policy, calls } = recordingPolicy({ pass: false, strength: 'inferred', reason: 'model-drop' })
    const runtime = makeRuntime({ mode: 'model', policy })

    // The model policy would drop this; sync ingest must stay on the rules.
    expect(runtime.ingest(action('sync-rules-only'))).toBe('stored')
    expect(calls).toHaveLength(0)
    expect(runtime.log.text()).toContain('slow-path sync ingest uses rules')
    expect(runtime.log.text().match(/slow-path sync ingest uses rules/g)).toHaveLength(1)
  })
})

describe('Runtime slow-path configuration', () => {
  it('defaults to rules and never fetches', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('default slow path must not fetch')
    })
    vi.stubGlobal('fetch', fetchSpy)
    const model = new HttpOpenAI('http://127.0.0.1:1/v1', 'fake-key', 'fake-model', 1000)
    const runtime = makeRuntime(undefined, {}, model)

    expect(runtime.slowPathMode).toBe('rules')
    expect(runtime.slowPathPolicy).toBeUndefined()
    expect(await runtime.ingestAsync(action('default-rules'))).toBe('stored')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('enables model mode from the environment with a bounded timeout', () => {
    const { policy } = recordingPolicy({ pass: true, strength: 'explicit', reason: 'ok' })
    const runtime = makeRuntime(undefined, {
      DS_AGENT_SLOW_PATH: 'model',
      DS_AGENT_SLOW_PATH_TIMEOUT_MS: '1500',
    })
    expect(runtime.slowPathMode).toBe('model')
    expect(runtime.slowPathPolicy?.name).toBe('MockModel')

    const injected = makeRuntime({ mode: 'model', policy }, { DS_AGENT_SLOW_PATH: 'rules' })
    expect(injected.slowPathMode).toBe('model')
    expect(injected.slowPathPolicy?.name).toBe('InjectedPolicy')
  })

  it('falls back to rules with a reason-only log on invalid configuration', () => {
    const badMode = makeRuntime(undefined, { DS_AGENT_SLOW_PATH: 'maybe' })
    expect(badMode.slowPathMode).toBe('rules')
    expect(badMode.log.text()).toContain('reason=invalid-mode')

    const badTimeout = makeRuntime(undefined, {
      DS_AGENT_SLOW_PATH: 'model',
      DS_AGENT_SLOW_PATH_TIMEOUT_MS: '5',
    })
    expect(badTimeout.slowPathMode).toBe('rules')
    expect(badTimeout.log.text()).toContain('reason=invalid-timeout')

    const tooLarge = makeRuntime({ mode: 'model', timeoutMs: 30_001 }, {})
    expect(tooLarge.slowPathMode).toBe('rules')
    expect(tooLarge.log.text()).toContain('reason=invalid-timeout')
  })

  it('stays on rules once when the model has no classifyPolicy', () => {
    const plain: Model = {
      name: 'PlainModel',
      classify: trigger => ruleClassify(trigger),
      async complete() {
        return { text: '' }
      },
    }
    const runtime = makeRuntime({ mode: 'model' }, {}, plain)
    expect(runtime.slowPathMode).toBe('rules')
    expect(runtime.log.text()).toContain('slow-path model unavailable')
    expect(runtime.log.text().match(/slow-path model unavailable/g)).toHaveLength(1)
  })
})

describe('HttpOpenAI.classifyPolicy', () => {
  const trigger = imTrigger({
    id: 'http-policy',
    thread: 'topic/slow-path',
    text: '@ds-agent please fix the login timeout',
  })

  it('makes one strict tool-free JSON call and parses a fenced object', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(
      '```json\n{"pass":true,"strength":"explicit","reason":"direct request"}\n```',
    ))
    vi.stubGlobal('fetch', fetchSpy)
    const model = new HttpOpenAI('http://127.0.0.1:9/v1/', 'test-api-key-sentinel', 'fake-model', 1000)

    await expect(model.classifyPolicy(trigger)).resolves.toEqual({
      pass: true,
      strength: 'explicit',
      reason: 'direct request',
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:9/v1/chat/completions')
    const body = JSON.parse(init.body as string) as {
      temperature: number
      max_tokens: number
      tools?: unknown
      messages: Array<{ role: string; content: string }>
    }
    expect(body.temperature).toBe(0)
    expect(body.max_tokens).toBeLessThanOrEqual(128)
    expect(body.tools).toBeUndefined()
    expect(body.messages[0]?.role).toBe('system')
    expect(body.messages[0]?.content).toContain('"pass"')
    expect(body.messages[1]?.role).toBe('user')
    expect(body.messages[1]?.content).toContain('source=im')
    expect(body.messages[1]?.content).toContain('addressed=mention')
    expect(body.messages[1]?.content).toContain(trigger.text)
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-api-key-sentinel')
    expect(JSON.stringify(body)).not.toContain('test-api-key-sentinel')
  })

  it('rejects invalid JSON, missing/unknown fields, and invalid strengths', async () => {
    expect(() => parsePolicyContent('not json')).toThrow(PolicyOutputError)
    expect(() => parsePolicyContent('{"pass":true,"strength":"explicit"}')).toThrow(PolicyOutputError)
    expect(() => parsePolicyContent('{"pass":true,"strength":"explicit","reason":"ok","extra":1}'))
      .toThrow(PolicyOutputError)
    expect(() => parsePolicyContent('{"pass":true,"strength":"certain","reason":"ok"}'))
      .toThrow(PolicyOutputError)
    expect(() => parsePolicyContent('{"pass":"yes","strength":"explicit","reason":"ok"}'))
      .toThrow(PolicyOutputError)

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('not json')))
    const model = new HttpOpenAI('http://127.0.0.1:9/v1', 'test-api-key-sentinel', 'fake-model', 1000)
    await expect(model.classifyPolicy(trigger)).rejects.toBeInstanceOf(PolicyOutputError)
  })

  it('clamps the reason to one short line', () => {
    const long = `line one\n${'x'.repeat(500)}`
    const hit = parsePolicyContent(JSON.stringify({ pass: true, strength: 'maybe', reason: long }))
    expect(hit.reason).toHaveLength(MAX_POLICY_REASON_LENGTH)
    expect(hit.reason).not.toContain('\n')
  })

  it('surfaces a sanitized PolicyClassifier fallback for invalid output, without the key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('{"unexpected":true}')))
    const key = 'test-api-key-sentinel'
    const model = new HttpOpenAI('http://127.0.0.1:9/v1', key, 'fake-model', 1000)
    const classifier = new PolicyClassifier(model, 500)
    await expect(classifier.classify(trigger))
      .resolves.toEqual({ ...ruleClassify(trigger), reason: 'fallback:invalid' })
  })

  it('never puts the key in an HTTP error', async () => {
    const key = 'test-api-key-sentinel'
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream failure', { status: 503 })))
    const model = new HttpOpenAI('http://127.0.0.1:9/v1', key, 'fake-model', 1000)
    let message = ''
    try {
      await model.classifyPolicy(trigger)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('503')
    expect(message).not.toContain(key)
    expect(message).not.toContain('upstream failure')
  })
})

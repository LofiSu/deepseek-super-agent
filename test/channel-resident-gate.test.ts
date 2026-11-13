import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RESIDENT_INGRESS_LIMIT,
  ingestResidentTrigger,
  ResidentIngressAbortedError,
  ResidentIngressRejectedError,
  residentIngressLimitFromEnv,
} from '../src/cli/channel-resident-gate.ts'
import { MockModel } from '../src/harness/model.ts'
import { Runtime } from '../src/runtime.ts'
import type { Trigger } from '../src/shared/types.ts'
import { tempHome } from './fixtures.ts'

function trigger(id: string): Trigger {
  return {
    id,
    source: 'cli',
    threads: [{ source: 'cli', id: 't' }],
    actor: { source: 'cli', id: 'u' },
    human: true,
    addressed: 'direct',
    at: new Date().toISOString(),
    text: 'hi',
    meta: {},
  }
}

describe('channel-resident-gate', () => {
  it('rejects when in-flight cap is saturated', async () => {
    const rt = Runtime.create({
      home: tempHome(),
      model: new MockModel(),
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      env: { ...process.env, DS_AGENT_ALLOW_MOCK_FIXTURE: '1' },
    })
    rt.start()
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const base = rt.ingestAsync.bind(rt)
    let calls = 0
    rt.ingestAsync = async (t: Trigger) => {
      calls += 1
      if (calls === 1) await hold
      return base(t)
    }
    const first = ingestResidentTrigger(rt, trigger('a'), { limit: 1, channel: 'feishu' })
    await new Promise(r => setTimeout(r, 15))
    await expect(
      ingestResidentTrigger(rt, trigger('b'), { limit: 1, channel: 'feishu', saturateWaitMs: 80 }),
    ).rejects.toBeInstanceOf(ResidentIngressRejectedError)
    release()
    await first
    await rt.finish()
  })

  it('throws on abort while saturated without ingesting or leaving reserved depth', async () => {
    const rt = Runtime.create({
      home: tempHome(),
      model: new MockModel(),
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      env: { ...process.env, DS_AGENT_ALLOW_MOCK_FIXTURE: '1' },
    })
    rt.start()
    let ingestedIds: string[] = []
    const base = rt.ingestAsync.bind(rt)
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    rt.ingestAsync = async (t: Trigger) => {
      ingestedIds.push(t.id)
      if (t.id === 'hold') await hold
      return base(t)
    }
    const ac = new AbortController()
    const first = ingestResidentTrigger(rt, trigger('hold'), { limit: 1, channel: 'feishu' })
    await new Promise(r => setTimeout(r, 15))
    const blocked = ingestResidentTrigger(rt, trigger('never'), {
      limit: 1,
      channel: 'feishu',
      signal: ac.signal,
      saturateWaitMs: 60_000,
    })
    ac.abort()
    await expect(blocked).rejects.toBeInstanceOf(ResidentIngressAbortedError)
    expect(ingestedIds).toEqual(['hold'])
    expect(rt.residentIngressDepth).toBe(1)
    release()
    await first
    expect(rt.residentIngressDepth).toBe(0)
    await rt.finish()
  })

  it('rejects when signal is already aborted before wait', async () => {
    const rt = Runtime.create({
      home: tempHome(),
      model: new MockModel(),
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      env: { ...process.env, DS_AGENT_ALLOW_MOCK_FIXTURE: '1' },
    })
    rt.start()
    let calls = 0
    const noop = rt.ingestAsync.bind(rt)
    rt.ingestAsync = async (t: Trigger) => {
      calls += 1
      return noop(t)
    }
    const ac = new AbortController()
    ac.abort()
    await expect(
      ingestResidentTrigger(rt, trigger('x'), { limit: 1, channel: 'imessage', signal: ac.signal }),
    ).rejects.toBeInstanceOf(ResidentIngressAbortedError)
    expect(calls).toBe(0)
    await rt.finish()
  })

  it('does not leak abort listeners across many saturated waits', async () => {
    const rt = Runtime.create({
      home: tempHome(),
      model: new MockModel(),
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      env: { ...process.env, DS_AGENT_ALLOW_MOCK_FIXTURE: '1' },
    })
    rt.start()
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const base = rt.ingestAsync.bind(rt)
    rt.ingestAsync = async (t: Trigger) => {
      if (t.id === 'hold') await hold
      return base(t)
    }
    const ac = new AbortController()
    void ingestResidentTrigger(rt, trigger('hold'), { limit: 1, channel: 'feishu' })
    await new Promise(r => setTimeout(r, 15))
    for (let i = 0; i < 40; i += 1) {
      await expect(
        ingestResidentTrigger(rt, trigger(`q${i}`), {
          limit: 1,
          channel: 'feishu',
          signal: ac.signal,
          saturateWaitMs: 5,
        }),
      ).rejects.toBeInstanceOf(ResidentIngressRejectedError)
    }
    expect(ac.signal.aborted).toBe(false)
    release()
    await rt.finish()
  })

  it('eventually ingests when capacity frees (queued wait)', async () => {
    const rt = Runtime.create({
      home: tempHome(),
      model: new MockModel(),
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      env: { ...process.env, DS_AGENT_ALLOW_MOCK_FIXTURE: '1' },
    })
    rt.start()
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const base = rt.ingestAsync.bind(rt)
    const seen: string[] = []
    rt.ingestAsync = async (t: Trigger) => {
      seen.push(t.id)
      if (t.id === 'a') await hold
      return base(t)
    }
    const first = ingestResidentTrigger(rt, trigger('a'), { limit: 1, channel: 'feishu' })
    await new Promise(r => setTimeout(r, 15))
    const second = ingestResidentTrigger(rt, trigger('b'), {
      limit: 1,
      channel: 'feishu',
      saturateWaitMs: 60_000,
    })
    await new Promise(r => setTimeout(r, 30))
    expect(seen).toEqual(['a'])
    release()
    await Promise.all([first, second])
    expect(seen).toEqual(['a', 'b'])
    await rt.finish()
  })

  it('documents limit 0 as explicit unbounded opt-out', () => {
    expect(residentIngressLimitFromEnv({ DS_AGENT_RESIDENT_INGRESS_LIMIT: '0' })).toBe(0)
    expect(residentIngressLimitFromEnv({ DS_AGENT_RESIDENT_INGRESS_LIMIT: '8' })).toBe(8)
    expect(residentIngressLimitFromEnv({ DS_AGENT_RESIDENT_INGRESS_LIMIT: '256' })).toBe(
      DEFAULT_RESIDENT_INGRESS_LIMIT,
    )
    expect(residentIngressLimitFromEnv({ DS_AGENT_RESIDENT_INGRESS_LIMIT: '  0  ' })).toBe(0)
    expect(residentIngressLimitFromEnv({})).toBeGreaterThan(0)
    expect(residentIngressLimitFromEnv({ DS_AGENT_RESIDENT_INGRESS_LIMIT: '' })).toBe(
      DEFAULT_RESIDENT_INGRESS_LIMIT,
    )
    expect(residentIngressLimitFromEnv({ DS_AGENT_RESIDENT_INGRESS_LIMIT: '   ' })).toBe(
      DEFAULT_RESIDENT_INGRESS_LIMIT,
    )
  })

  it('rejects malformed numeric prefixes instead of silently truncating', () => {
    // `Number.parseInt` accepts a leading decimal run and ignores the rest;
    // a typo must never shrink or remove the backpressure bound. Only "0"
    // requests the unbounded opt-out.
    for (const raw of ['0abc', '0x10', '1e3', '7.5', '1_000', '+8', '-0', '0.0', '256abc', 'abc', '-1']) {
      expect(residentIngressLimitFromEnv({ DS_AGENT_RESIDENT_INGRESS_LIMIT: raw }), raw).toBe(
        DEFAULT_RESIDENT_INGRESS_LIMIT,
      )
    }
  })

  it('accepts leading zeros on a true decimal without treating them as octal', () => {
    expect(residentIngressLimitFromEnv({ DS_AGENT_RESIDENT_INGRESS_LIMIT: '08' })).toBe(8)
    expect(residentIngressLimitFromEnv({ DS_AGENT_RESIDENT_INGRESS_LIMIT: '000' })).toBe(0)
  })
})

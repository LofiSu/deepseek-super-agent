import { describe, expect, it } from 'vitest'
import {
  ingestResidentTrigger,
  ResidentIngressRejectedError,
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
})


/**
 * Local mock HTTP only: burst polls, disconnect/backoff, shutdown semantics.
 */
import { describe, expect, it } from 'vitest'
import { FeishuClient } from '../src/channels/feishu.ts'
import { runFeishuLoop, type FeishuLoopSource } from '../src/cli/feishu.ts'
import { startServeChannels } from '../src/cli/channels.ts'
import { MockModel } from '../src/harness/model.ts'
import { Runtime } from '../src/runtime.ts'
import type { Trigger } from '../src/shared/types.ts'
import { tempHome } from './fixtures.ts'

function feishuTrigger(id: string, ms: number): Trigger {
  return {
    id: `feishu_${id}`,
    source: 'im',
    threads: [{ source: 'im', id: 'feishu:oc_burst' }],
    actor: { source: 'im', id: 'ou_alice' },
    human: true,
    addressed: 'mention',
    at: new Date(ms).toISOString(),
    text: '@ds-agent burst',
    channel: {
      source: 'im',
      thread: 'feishu:oc_burst',
      address: { provider: 'feishu', chat_id: 'oc_burst', group: 'oc_burst', message_id: id },
    },
    meta: { provider: 'feishu', chat_id: 'oc_burst', message_id: id, msg_type: 'text', sender_type: 'user' },
  }
}

class BurstFeishu implements FeishuLoopSource {
  pulls = 0
  cursorMs = 0
  restoreCursor(cursorMs: number): void {
    this.cursorMs = cursorMs
  }
  async pull(): Promise<readonly Trigger[]> {
    this.pulls += 1
    if (this.pulls === 1) {
      const batch = [feishuTrigger('a', 1_761_958_800_000), feishuTrigger('b', 1_761_958_801_000)]
      for (const t of batch) this.cursorMs = Math.max(this.cursorMs, Date.parse(t.at))
      return batch
    }
    if (this.pulls === 2) throw new Error('disconnect')
    return []
  }
}

describe('deployment serve resident e2e (loopback mocks)', () => {
  it('feishu burst then backoff on poll error until abort', async () => {
    const rt = Runtime.create({
      home: tempHome(),
      model: new MockModel(),
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      env: { ...process.env, DS_AGENT_ALLOW_MOCK_FIXTURE: '1', DS_AGENT_GROUP_ALLOWLIST: 'oc_burst' },
    })
    rt.start()
    const ingested: string[] = []
    const base = rt.ingestAsync.bind(rt)
    rt.ingestAsync = async (t: Trigger) => { ingested.push(t.id); return base(t) }
    const client = new FeishuClient(
      { appId: 'a', appSecret: 's', baseUrl: 'https://open.feishu.cn' },
      async () => { throw new Error('network disabled') },
    )
    const controller = new AbortController()
    const source = new BurstFeishu()
    const loop = runFeishuLoop({
      runtime: rt,
      chatId: 'oc_burst',
      client,
      createSource: () => source,
      intervalMs: 5,
      maxBackoffMs: 20,
      signal: controller.signal,
    })
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline && source.pulls < 2) {
      await new Promise(r => setTimeout(r, 20))
    }
    controller.abort()
    await loop
    expect(ingested).toEqual(expect.arrayContaining(['feishu_a', 'feishu_b']))
    expect(source.pulls).toBeGreaterThanOrEqual(2)
    expect(rt.log.text()).toContain('[feishu] poll error')
    await rt.finish()
  })

  it('startServeChannels feishu-only aborts without hang', async () => {
    const rt = Runtime.create({
      home: tempHome(),
      model: new MockModel(),
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      env: { ...process.env, DS_AGENT_ALLOW_MOCK_FIXTURE: '1', DS_AGENT_GROUP_ALLOWLIST: 'oc_x' },
    })
    rt.start()
    const client = new FeishuClient(
      { appId: 'a', appSecret: 's', baseUrl: 'https://open.feishu.cn' },
      async () => { throw new Error('network disabled') },
    )
    const channels = startServeChannels({
      runtime: rt,
      feishu: {
        config: { appId: 'a', appSecret: 's', baseUrl: 'https://open.feishu.cn', chatId: 'oc_x' },
        chatId: 'oc_x',
        intervalMs: 20,
        since: Number.NaN,
        once: false,
      },
      createFeishuClient: () => client,
      runFeishu: opts => runFeishuLoop({
        ...opts,
        createSource: () => ({
          pulls: 0,
          cursorMs: 0,
          restoreCursor() {},
          async pull() { return [] },
        }),
      }),
    })
    await new Promise(r => setTimeout(r, 30))
    channels.abort()
    await Promise.race([
      channels.wait(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('hang')), 3_000)),
    ])
    await rt.finish()
  })
})

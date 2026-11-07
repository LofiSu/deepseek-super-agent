/**
 * Resident inbound channel lifecycle (loopback/fake adapters only).
 * Complements test/deployment-loopback-integration.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { FeishuClient } from '../src/channels/feishu.ts'
import { runFeishuLoop, type FeishuLoopSource } from '../src/cli/feishu.ts'
import { runImessageLoop } from '../src/cli/channel-loop.ts'
import { ImessageSource, type ImessageApi, type ImessageInbound } from '../src/channels/imessage.ts'
import { MockModel } from '../src/harness/model.ts'
import { Runtime } from '../src/runtime.ts'
import type { Trigger } from '../src/shared/types.ts'
import { tempHome } from './fixtures.ts'

function noNetworkFeishu(): FeishuClient {
  return new FeishuClient(
    { appId: 'app', appSecret: 'secret', baseUrl: 'https://open.feishu.cn' },
    async () => { throw new Error('network disabled') },
  )
}

class CountingFeishuSource implements FeishuLoopSource {
  pulls = 0
  private cursor = 0
  constructor(
    private readonly batch: readonly Trigger[] = [],
    private readonly failPull?: number,
  ) {}
  get cursorMs(): number {
    return this.cursor
  }
  async pull(): Promise<readonly Trigger[]> {
    this.pulls += 1
    if (this.failPull !== undefined && this.pulls >= this.failPull) {
      throw new Error('simulated feishu poll failure')
    }
    if (this.pulls === 1) {
      for (const item of this.batch) {
        this.cursor = Math.max(this.cursor, Date.parse(item.at))
      }
      return this.batch
    }
    return []
  }
}

function runtime(): Runtime {
  return Runtime.create({
    home: tempHome(),
    model: new MockModel(),
    jobDelayMs: 0,
    watchdogIntervalMs: 60_000,
    env: { ...process.env, DS_AGENT_ALLOW_MOCK_FIXTURE: '1', DS_AGENT_GROUP_ALLOWLIST: 'oc_test' },
  })
}

function feishuTrigger(id: string, ms: number): Trigger {
  return {
    id: `feishu_${id}`,
    source: 'im',
    threads: [{ source: 'im', id: 'feishu:oc_test' }],
    actor: { source: 'im', id: 'ou_alice' },
    human: true,
    addressed: 'mention',
    at: new Date(ms).toISOString(),
    text: '@ds-agent hi',
    channel: {
      source: 'im',
      thread: 'feishu:oc_test',
      address: { provider: 'feishu', chat_id: 'oc_test', group: 'oc_test', message_id: id },
    },
    meta: { provider: 'feishu', chat_id: 'oc_test', message_id: id, msg_type: 'text', sender_type: 'user' },
  }
}

class FakeImessage implements ImessageApi {
  pulls = 0
  constructor(private readonly rows: ImessageInbound[] = []) {}
  async pull(afterRowId: number): Promise<ImessageInbound[]> {
    this.pulls += 1
    return this.rows.filter(row => row.rowId > afterRowId)
  }
  async maxRowId(): Promise<number> { return 0 }
  async send(): Promise<{ externalId: string }> { return { externalId: 'x' } }
}

describe('deployment resident channel lifecycle', () => {
  it('feishu loop does not redeliver the same message after cursor advance (dedupe)', async () => {
    const rt = runtime()
    rt.start()
    const source = new CountingFeishuSource([feishuTrigger('om_1', 1_761_958_800_000)])
    const ingested: string[] = []
    const base = rt.ingestAsync.bind(rt)
    rt.ingestAsync = async (t: Trigger) => {
      ingested.push(t.id)
      return base(t)
    }

    await runFeishuLoop({
      runtime: rt,
      chatId: 'oc_test',
      client: noNetworkFeishu(),
      createSource: () => source,
      intervalMs: 5,
      once: true,
    })
    await runFeishuLoop({
      runtime: rt,
      chatId: 'oc_test',
      client: noNetworkFeishu(),
      createSource: () => new CountingFeishuSource([]),
      intervalMs: 5,
      once: true,
    })
    expect(ingested).toEqual(['feishu_om_1'])
    await rt.finish()
  })

  it('feishu loop logs poll errors and exits cleanly on abort', async () => {
    const rt = runtime()
    rt.start()
    const controller = new AbortController()
    const source = new CountingFeishuSource([], 1)
    const loop = runFeishuLoop({
      runtime: rt,
      chatId: 'oc_test',
      client: noNetworkFeishu(),
      createSource: () => source,
      intervalMs: 5,
      signal: controller.signal,
    })
    await new Promise(r => setTimeout(r, 20))
    controller.abort()
    await loop
    expect(rt.log.text()).toContain('[feishu] poll error')
    await rt.finish()
  })

  it('imessage loop stops outbound flush timer after abort', async () => {
    const rt = runtime()
    rt.start()
    const api = new FakeImessage()
    const controller = new AbortController()
    const loop = runImessageLoop({
      runtime: rt,
      source: new ImessageSource(api),
      api,
      dbPath: 'unused.db',
      intervalMs: 5,
      signal: controller.signal,
    })
    await new Promise(r => setTimeout(r, 25))
    controller.abort()
    const reason = await Promise.race([
      loop,
      new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('hang')), 2_000)),
    ])
    expect(reason).toBe('aborted')
    await rt.finish()
  })
})

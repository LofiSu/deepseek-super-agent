/**
 * Resident inbound channel lifecycle (loopback/fake adapters only).
 * Complements test/deployment-loopback-integration.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { FeishuClient } from '../src/channels/feishu.ts'
import { runFeishuLoop, type FeishuLoopSource } from '../src/cli/feishu.ts'
import { runImessageLoop } from '../src/cli/channel-loop.ts'
import {
  ImessageSource,
  imessageTrigger,
  type ImessageApi,
  type ImessageInbound,
} from '../src/channels/imessage.ts'
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
  restoreCursor(cursorMs: number): void {
    this.cursor = cursorMs
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

/**
 * Behaves like the production `FeishuSource`: each pull filters by the current
 * in-memory cursor with only a one-second overlap and advances the cursor to
 * the newest message in the returned batch.
 */
class WindowFeishuSource implements FeishuLoopSource {
  pulls = 0
  readonly batches: string[][] = []
  private cursor: number

  constructor(private readonly messages: readonly Trigger[], initialCursorMs: number) {
    this.cursor = initialCursorMs
  }

  get cursorMs(): number {
    return this.cursor
  }

  restoreCursor(cursorMs: number): void {
    this.cursor = cursorMs
  }

  async pull(): Promise<readonly Trigger[]> {
    this.pulls += 1
    const startTimeSec = Math.max(0, Math.floor((this.cursor - 1_000) / 1_000))
    const seen = this.messages.filter(
      item => Math.floor(Date.parse(item.at) / 1_000) >= startTimeSec,
    )
    this.batches.push(seen.map(item => item.id))
    for (const item of seen) {
      const at = Date.parse(item.at)
      if (Number.isFinite(at) && at > this.cursor) this.cursor = at
    }
    return seen
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

const IMESSAGE_HANDLE = '+15550000000'

/** Runtime whose admission allowlists the fake iMessage sender. */
function imessageRuntime(): Runtime {
  return Runtime.create({
    home: tempHome(),
    model: new MockModel(),
    jobDelayMs: 0,
    watchdogIntervalMs: 60_000,
    env: {
      ...process.env,
      DS_AGENT_ALLOW_MOCK_FIXTURE: '1',
      DS_AGENT_ACTOR_ALLOWLIST: IMESSAGE_HANDLE,
    },
  })
}

function aliceInbound(rowId: number, guid: string, text: string): ImessageInbound {
  return {
    rowId,
    guid,
    text,
    handle: IMESSAGE_HANDLE,
    service: 'iMessage',
    chatGuid: `iMessage;-;${IMESSAGE_HANDLE}`,
    at: new Date(1_761_958_800_000 + rowId * 1_000).toISOString(),
  }
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
    const cursor = rt.store.getDoc<{ chatId: string; lastCreateTimeMs: number }>('feishu_cursor', 'cursor')
    expect(cursor?.chatId).toBe('oc_test')
    expect(cursor?.lastCreateTimeMs).toBe(1_761_958_800_000)
    await rt.finish()
  })

  it('feishu loop does not advance cursor when ingress aborts under saturation', async () => {
    const rt = Runtime.create({
      home: tempHome(),
      model: new MockModel(),
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      env: {
        ...process.env,
        DS_AGENT_ALLOW_MOCK_FIXTURE: '1',
        DS_AGENT_GROUP_ALLOWLIST: 'oc_test',
        DS_AGENT_RESIDENT_INGRESS_LIMIT: '1',
      },
    })
    rt.start()
    const batch = [
      feishuTrigger('hold', 1_761_958_800_000),
      feishuTrigger('lost', 1_761_958_801_000),
    ]
    const ingested: string[] = []
    let release!: () => void
    const holdFirst = new Promise<void>(resolve => { release = resolve })
    const base = rt.ingestAsync.bind(rt)
    rt.ingestAsync = async (t: Trigger) => {
      ingested.push(t.id)
      if (t.id === 'feishu_hold') await holdFirst
      return base(t)
    }
    const source = new CountingFeishuSource(batch)
    const controller = new AbortController()
    const loop = runFeishuLoop({
      runtime: rt,
      chatId: 'oc_test',
      client: noNetworkFeishu(),
      createSource: () => source,
      intervalMs: 5,
      signal: controller.signal,
    })
    const deadline = Date.now() + 2_000
    while (!ingested.includes('feishu_hold') && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10))
    }
    expect(ingested).toContain('feishu_hold')
    controller.abort()
    release()
    await Promise.race([
      loop,
      new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('loop hang')), 5_000)),
    ])
    expect(ingested).toEqual(['feishu_hold'])
    const cursor = rt.store.getDoc<{ chatId: string; lastCreateTimeMs: number }>('feishu_cursor', 'cursor')
    expect(cursor).toBeUndefined()
    await rt.finish()
  })

  it('feishu loop replays the uningested window after a saturation rejection', async () => {
    // `runFeishuLoop` reads the ingress cap from process.env.
    const previousLimit = process.env.DS_AGENT_RESIDENT_INGRESS_LIMIT
    process.env.DS_AGENT_RESIDENT_INGRESS_LIMIT = '1'
    try {
      const rt = Runtime.create({
        home: tempHome(),
        model: new MockModel(),
        jobDelayMs: 0,
        watchdogIntervalMs: 60_000,
        env: {
          ...process.env,
          DS_AGENT_ALLOW_MOCK_FIXTURE: '1',
          DS_AGENT_GROUP_ALLOWLIST: 'oc_test',
          DS_AGENT_RESIDENT_INGRESS_LIMIT: '1',
        },
      })
      rt.start()
      const rejectedMs = 1_761_958_800_000
      const laterMs = rejectedMs + 2_500
      const source = new WindowFeishuSource(
        [feishuTrigger('om_rejected', rejectedMs), feishuTrigger('om_later', laterMs)],
        rejectedMs - 6_000,
      )

      // Occupy the only ingress slot so the first inbound trigger waits out the
      // short cap and is rejected; release it once the loop logs the failure.
      expect(rt.tryResidentIngressBegin(1)).toBe(true)
      const controller = new AbortController()
      const loop = runFeishuLoop({
        runtime: rt,
        chatId: 'oc_test',
        client: noNetworkFeishu(),
        createSource: () => source,
        intervalMs: 5,
        saturateWaitMs: 25,
        signal: controller.signal,
      })

      const deadline = Date.now() + 3_000
      let released = false
      while (Date.now() < deadline) {
        if (!released && rt.log.text().includes('[feishu] ingest failed')) {
          rt.residentIngressEnd()
          released = true
        }
        if (rt.store.listDocs<Trigger>('trigger').length >= 2) break
        await new Promise(r => setTimeout(r, 5))
      }
      controller.abort()
      await Promise.race([
        loop,
        new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('loop hang')), 5_000)),
      ])

      expect(released).toBe(true)
      // Both triggers are more than the one-second overlap apart. The pull after
      // the rejection must still return the uningested older trigger.
      expect(source.batches[0]).toEqual(['feishu_om_rejected', 'feishu_om_later'])
      expect(source.batches[1]).toEqual(['feishu_om_rejected', 'feishu_om_later'])
      // Replaying the window is safe: Runtime dedupes by Trigger id.
      expect(rt.store.listDocs<Trigger>('trigger').map(item => item.id).sort())
        .toEqual(['feishu_om_later', 'feishu_om_rejected'])
      // The durable cursor is persisted only for the successful window.
      expect(rt.store.getDoc<{ chatId: string; lastCreateTimeMs: number }>('feishu_cursor', 'cursor'))
        .toEqual({ chatId: 'oc_test', lastCreateTimeMs: laterMs })
      await rt.finish()
    } finally {
      if (previousLimit === undefined) delete process.env.DS_AGENT_RESIDENT_INGRESS_LIMIT
      else process.env.DS_AGENT_RESIDENT_INGRESS_LIMIT = previousLimit
    }
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

  it('imessage loop ingests a new message instead of coalescing it into a replayed id', async () => {
    const rt = imessageRuntime()
    rt.start()
    // A prior successful poll persisted the cursor at row 5.
    rt.store.putDoc('imessage_cursor', 'cursor', { rowId: 5 })
    // Models a crash after ingesting row 6 but before the cursor write: the
    // trigger is durable, the cursor still points behind it.
    await rt.ingestAsync(imessageTrigger(aliceInbound(6, 'GUID-A', '第一句')))
    expect(rt.store.getDoc<Trigger>('trigger', 'imessage_GUID-A')?.text).toBe('第一句')
    expect(rt.store.getDoc<{ rowId: number }>('imessage_cursor', 'cursor')).toEqual({ rowId: 5 })

    const api = new FakeImessage([
      aliceInbound(6, 'GUID-A', '第一句'),
      aliceInbound(7, 'GUID-B', '第二句'),
    ])
    const ingested: string[] = []
    const base = rt.ingestAsync.bind(rt)
    rt.ingestAsync = async (trigger: Trigger) => {
      ingested.push(trigger.id)
      return base(trigger)
    }

    await runImessageLoop({
      runtime: rt,
      source: new ImessageSource(api),
      api,
      dbPath: 'unused.db',
      intervalMs: 5,
      once: true,
    })

    // The replay must not fold row 7 into the already-ingested row 6 id, or
    // Runtime would answer `duplicate` and row 7's text would be lost.
    expect(ingested).toEqual(['imessage_GUID-B'])
    expect(rt.store.getDoc<Trigger>('trigger', 'imessage_GUID-A')?.text).toBe('第一句')
    expect(rt.store.getDoc<Trigger>('trigger', 'imessage_GUID-B')?.text).toBe('第二句')
    expect(rt.store.getDoc<{ rowId: number }>('imessage_cursor', 'cursor')).toEqual({ rowId: 7 })
    await rt.finish()
  })

  it('imessage loop still coalesces a first-seen consecutive 1:1 burst', async () => {
    const rt = imessageRuntime()
    rt.start()
    const api = new FakeImessage([
      aliceInbound(6, 'GUID-A', '第一句'),
      aliceInbound(7, 'GUID-B', '第二句'),
    ])
    const ingested: string[] = []
    const base = rt.ingestAsync.bind(rt)
    rt.ingestAsync = async (trigger: Trigger) => {
      ingested.push(trigger.id)
      return base(trigger)
    }

    await runImessageLoop({
      runtime: rt,
      source: new ImessageSource(api),
      api,
      dbPath: 'unused.db',
      intervalMs: 5,
      once: true,
    })

    expect(ingested).toEqual(['imessage_GUID-A'])
    expect(rt.store.getDoc<Trigger>('trigger', 'imessage_GUID-A')?.text).toBe('第一句\n第二句')
    expect(rt.store.getDoc<Trigger>('trigger', 'imessage_GUID-B')).toBeUndefined()
    expect(rt.store.getDoc<{ rowId: number }>('imessage_cursor', 'cursor')).toEqual({ rowId: 7 })
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

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FeishuClient } from '../src/channels/feishu.ts'
import { imTrigger } from '../src/channels/im.ts'
import type { ImessageApi } from '../src/channels/imessage.ts'
import { runImessageLoop, type ImessageLoopSource } from '../src/cli/channel-loop.ts'
import { runFeishuLoop, type FeishuLoopSource } from '../src/cli/feishu.ts'
import { MockModel } from '../src/harness/model.ts'
import type { SemanticHit } from '../src/ingress/filter.ts'
import type { SemanticPolicy } from '../src/ingress/policy.ts'
import { Runtime, type SlowPathOptions } from '../src/runtime.ts'
import type { Disposition, Ticket, Trigger } from '../src/shared/types.ts'

/**
 * T17 follow-through: the real inbound loops must use `Runtime.ingestAsync` so
 * the opt-in model Slow Path applies. Every policy is injected; no test uses a
 * live model, channel, credential, or network.
 */

const dirs: string[] = []
const runtimes: Runtime[] = []

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.daemon.stop()
    if (runtime.store.isOpen) runtime.store.close()
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function makeRuntime(slowPath?: SlowPathOptions): Runtime {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-channel-slow-path-'))
  dirs.push(home)
  const runtime = Runtime.create({
    home,
    model: new MockModel(),
    slowPath,
    jobDelayMs: 0,
    watchdogIntervalMs: 60_000,
    // Keep Eval out of these ingress assertions; the timer is unref'd.
    batchWindowMs: 60_000,
  })
  runtimes.push(runtime)
  return runtime
}

/** Fast path passes on the mention; only the policy can decide. */
function request(id: string): Trigger {
  return imTrigger({
    id,
    thread: 'topic/channel-slow-path',
    text: '@ds-agent please fix the login timeout',
  })
}

/** Fast path passes as `observed`; the deterministic rules drop it. */
function observed(id: string): Trigger {
  return imTrigger({
    id,
    thread: 'topic/channel-slow-path',
    text: 'circling back on the notes from yesterday standup, sharing for visibility only',
    addressed: false,
  })
}

function droppingPolicy(reason = 'channel-drop'): { policy: SemanticPolicy; calls: Trigger[] } {
  const calls: Trigger[] = []
  const hit: SemanticHit = { pass: false, strength: 'inferred', reason }
  return {
    calls,
    policy: {
      name: 'InjectedChannelPolicy',
      async classifyPolicy(trigger: Trigger): Promise<SemanticHit> {
        calls.push(trigger)
        return hit
      },
    },
  }
}

function throwingPolicy(): { policy: SemanticPolicy; calls: Trigger[] } {
  const calls: Trigger[] = []
  return {
    calls,
    policy: {
      name: 'ThrowingChannelPolicy',
      async classifyPolicy(trigger: Trigger): Promise<SemanticHit> {
        calls.push(trigger)
        throw new Error('policy backend down')
      },
    },
  }
}

/** Fail loudly if anything reaches for the network. */
function forbidNetwork(): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn(() => {
    throw new Error('channel loops must not fetch')
  })
  vi.stubGlobal('fetch', fetchSpy)
  return fetchSpy
}

/** Record the disposition state at the moment the cursor row is persisted. */
function watchCursorWrite(
  runtime: Runtime,
  kind: string,
  dispositionId: string,
): string[] {
  const seen: string[] = []
  const original = runtime.store.putDoc.bind(runtime.store)
  vi.spyOn(runtime.store, 'putDoc').mockImplementation((docKind, id, value) => {
    if (docKind === kind) {
      const disposition = runtime.store.getDoc<Disposition>('disposition', dispositionId)
      seen.push(disposition?.filtered ?? '<missing>')
    }
    original(docKind, id, value)
  })
  return seen
}

function imessageSource(
  triggers: readonly Trigger[],
  lastRowId: number,
): { source: ImessageLoopSource; pulls: number[] } {
  const pulls: number[] = []
  return {
    pulls,
    source: {
      async pull(afterRowId: number) {
        pulls.push(afterRowId)
        return { triggers, lastRowId }
      },
    },
  }
}

function imessageApi(): ImessageApi {
  return {
    async pull() { return [] },
    async maxRowId() { return 0 },
    async send() { throw new Error('outbox send must not run for a filtered trigger') },
  }
}

function feishuSource(
  triggers: readonly Trigger[],
  cursorMs: number,
): { source: FeishuLoopSource; pulls: () => number } {
  let pulls = 0
  return {
    pulls: () => pulls,
    source: {
      async pull() {
        pulls += 1
        return triggers
      },
      get cursorMs() { return cursorMs },
    },
  }
}

function feishuClient(): FeishuClient {
  return {
    async replyText() { throw new Error('outbox reply must not run for a filtered trigger') },
    async sendText() { throw new Error('outbox send must not run for a filtered trigger') },
  } as unknown as FeishuClient
}

describe('inbound channel loops use the model slow path', () => {
  it('iMessage drops via the policy, persists the cursor, and never creates a ticket', async () => {
    const { policy, calls } = droppingPolicy('channel-drop')
    const runtime = makeRuntime({ mode: 'model', policy })
    const fetchSpy = forbidNetwork()
    const { source, pulls } = imessageSource([request('im-channel-drop')], 42)
    const cursorWrites = watchCursorWrite(runtime, 'imessage_cursor', 'im-channel-drop')

    const reason = await runImessageLoop({
      runtime,
      source,
      api: imessageApi(),
      dbPath: 'unused-chat.db',
      since: 1,
      once: true,
    })

    expect(reason).toBe('once')
    expect(pulls).toEqual([1])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.id).toBe('im-channel-drop')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(runtime.store.getDoc<Disposition>('disposition', 'im-channel-drop')?.filtered)
      .toBe('semantic:channel-drop')
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(0)
    // The cursor is written only after the trigger's disposition exists.
    expect(cursorWrites).toEqual(['semantic:channel-drop'])
    expect(runtime.store.getDoc<{ rowId: number }>('imessage_cursor', 'cursor')?.rowId)
      .toBe(42)
  })

  it('Feishu drops via the policy, persists the cursor, and never creates a ticket', async () => {
    const { policy, calls } = droppingPolicy('channel-drop')
    const runtime = makeRuntime({ mode: 'model', policy })
    const fetchSpy = forbidNetwork()
    const { source, pulls } = feishuSource([request('feishu-channel-drop')], 5_000)
    const cursorWrites = watchCursorWrite(runtime, 'feishu_cursor', 'feishu-channel-drop')

    const reason = await runFeishuLoop({
      runtime,
      chatId: 'oc_channel_slow_path',
      client: feishuClient(),
      createSource: () => source,
      since: 1,
      once: true,
    })

    expect(reason).toBe('once')
    expect(pulls()).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.id).toBe('feishu-channel-drop')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(runtime.store.getDoc<Disposition>('disposition', 'feishu-channel-drop')?.filtered)
      .toBe('semantic:channel-drop')
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(0)
    // The cursor is written only after the trigger's disposition exists.
    expect(cursorWrites).toEqual(['semantic:channel-drop'])
    expect(runtime.store.getDoc<{ chatId: string; lastCreateTimeMs: number }>(
      'feishu_cursor',
      'cursor',
    )).toEqual({ chatId: 'oc_channel_slow_path', lastCreateTimeMs: 5_000 })
  })

  it('does not reject or skip the cursor when the injected policy throws', async () => {
    const { policy, calls } = throwingPolicy()
    const runtime = makeRuntime({ mode: 'model', policy })
    const fetchSpy = forbidNetwork()
    // The deterministic rules would drop this notice; the policy fallback does too.
    const { source } = imessageSource([observed('im-channel-fallback')], 43)

    const reason = await runImessageLoop({
      runtime,
      source,
      api: imessageApi(),
      dbPath: 'unused-chat.db',
      since: 1,
      once: true,
    })

    expect(reason).toBe('once')
    expect(calls).toHaveLength(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(runtime.store.getDoc<Disposition>('disposition', 'im-channel-fallback')?.filtered)
      .toBe('semantic:fallback:error')
    expect(runtime.store.getDoc<{ rowId: number }>('imessage_cursor', 'cursor')?.rowId)
      .toBe(43)
  })

  it('keeps the default rules mode admitting a normal trigger', async () => {
    const runtime = makeRuntime()
    const fetchSpy = forbidNetwork()
    const { source } = imessageSource([request('im-channel-default')], 44)

    const reason = await runImessageLoop({
      runtime,
      source,
      api: imessageApi(),
      dbPath: 'unused-chat.db',
      since: 1,
      once: true,
    })

    expect(reason).toBe('once')
    expect(runtime.slowPathMode).toBe('rules')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(runtime.store.getDoc<Trigger>('trigger', 'im-channel-default')).toBeDefined()
    expect(runtime.store.getDoc<Disposition>('disposition', 'im-channel-default')?.filtered)
      .toBeUndefined()
    expect(runtime.store.getDoc<{ rowId: number }>('imessage_cursor', 'cursor')?.rowId)
      .toBe(44)
  })
})

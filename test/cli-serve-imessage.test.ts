import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ImessageSource,
  type ImessageApi,
  type ImessageInbound,
  type ImessagePullOptions,
} from '../src/channels/imessage.ts'
import { runImessageLoop } from '../src/cli/channel-loop.ts'
import { resolveImessageCliConfig } from '../src/cli/imessage.ts'
import { MockModel } from '../src/harness/model.ts'
import { Runtime } from '../src/runtime.ts'
import type { Trigger } from '../src/shared/types.ts'

/**
 * Offline coverage for the inbound loop that `serve --imessage` runs. No real
 * chat.db or osascript is touched: the API/source are fakes and the Runtime is
 * driven by MockModel.
 */

const children: ChildProcess[] = []
const homes: string[] = []
const runtimes: Runtime[] = []
const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function makeRuntime(env: NodeJS.ProcessEnv = {}): Runtime {
  const home = tempDir('ds-agent-serve-imessage-home-')
  homes.push(home)
  const runtime = Runtime.create({
    home,
    model: new MockModel(),
    jobDelayMs: 0,
    watchdogIntervalMs: 60_000,
    env: { ...process.env, DS_AGENT_ACTOR_ALLOWLIST: '+15550000000', ...env },
  })
  runtime.start()
  runtimes.push(runtime)
  return runtime
}

function sample(over: Partial<ImessageInbound> = {}): ImessageInbound {
  return {
    rowId: 10,
    guid: 'GUID-1',
    text: 'hello ds-agent',
    handle: '+15550000000',
    service: 'iMessage',
    chatGuid: 'iMessage;-;+15550000000',
    at: '2026-11-02T08:00:00.000Z',
    ...over,
  }
}

/** Fake API: optionally fails the first N pulls, then serves message rows. */
class FakeImessage implements ImessageApi {
  pulls = 0
  sent: { target: { handle?: string; chatGuid?: string }; text: string }[] = []

  constructor(
    private readonly messages: ImessageInbound[] = [],
    private readonly failFirst = 0,
  ) {}

  async pull(afterRowId: number, opts: ImessagePullOptions = {}): Promise<ImessageInbound[]> {
    this.pulls += 1
    if (this.pulls <= this.failFirst) throw new Error(`pull failed #${this.pulls}`)
    return this.messages.filter(message =>
      message.rowId > afterRowId && (!opts.handle || message.handle === opts.handle))
  }

  /** Seed at 0 so pre-seeded fixture rows are delivered with `since` unset. */
  async maxRowId(): Promise<number> {
    return 0
  }

  async send(target: { handle?: string; chatGuid?: string }, text: string): Promise<{ externalId: string }> {
    this.sent.push({ target, text })
    return { externalId: `ext_${this.sent.length}` }
  }
}

function spyIngest(runtime: Runtime): Trigger[] {
  const ingested: Trigger[] = []
  const original = runtime.ingest.bind(runtime)
  runtime.ingest = (trigger: Trigger) => {
    ingested.push(trigger)
    return original(trigger)
  }
  return ingested
}

function logText(runtime: Runtime): string {
  return runtime.log.text()
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timed out waiting for the loop to stop')), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  for (const runtime of runtimes.splice(0)) {
    if (runtime.store.isOpen) {
      runtime.daemon.stop()
      await runtime.finish().catch(() => undefined)
    }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('serve --imessage loop', () => {
  it('ingests a triggered message and advances the persisted cursor', async () => {
    const runtime = makeRuntime()
    const ingested = spyIngest(runtime)
    const api = new FakeImessage([sample({ rowId: 10 })])

    const reason = await runImessageLoop({
      runtime,
      source: new ImessageSource(api),
      api,
      dbPath: 'unused-chat.db',
      handle: '+15550000000',
      intervalMs: 5,
      once: true,
    })

    expect(reason).toBe('once')
    expect(ingested.map(trigger => trigger.id)).toEqual(['imessage_GUID-1'])
    expect(logText(runtime)).toContain('[imessage] inbound id=imessage_GUID-1')
    expect(runtime.store.getDoc<{ rowId: number }>('imessage_cursor', 'cursor')).toEqual({ rowId: 10 })
  })

  it('retries a failing pull with bounded backoff and keeps polling', async () => {
    const runtime = makeRuntime()
    const ingested = spyIngest(runtime)
    const api = new FakeImessage([sample({ rowId: 7 })], 1)
    const controller = new AbortController()

    const loop = runImessageLoop({
      runtime,
      source: new ImessageSource(api),
      api,
      dbPath: 'unused-chat.db',
      handle: '+15550000000',
      intervalMs: 5,
      maxBackoffMs: 20,
      signal: controller.signal,
    })

    await waitFor(() => ingested.length === 1)
    expect(api.pulls).toBeGreaterThanOrEqual(2)
    expect(logText(runtime)).toContain('[imessage] poll error pull failed #1')
    // The loop survived the failed pull and delivered the later message.
    expect(ingested.map(trigger => trigger.id)).toEqual(['imessage_GUID-1'])

    controller.abort()
    await withTimeout(loop, 1_000)
  })

  it('stops polling promptly when aborted and leaves no pending timer', async () => {
    const runtime = makeRuntime()
    const api = new FakeImessage([])
    const controller = new AbortController()

    const loop = runImessageLoop({
      runtime,
      source: new ImessageSource(api),
      api,
      dbPath: 'unused-chat.db',
      intervalMs: 5,
      signal: controller.signal,
    })

    await waitFor(() => api.pulls >= 2)
    controller.abort()
    const reason = await withTimeout(loop, 1_000)
    expect(reason).toBe('aborted')

    const settledPulls = api.pulls
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(api.pulls).toBe(settledPulls)
  })

  it('refuses serve --imessage before opening chat.db or SQLite', async () => {
    const dir = tempDir('ds-agent-serve-imessage-deny-')
    const stateHome = path.join(dir, 'state')
    const dbPath = path.join(dir, 'missing-chat.db')
    const env: NodeJS.ProcessEnv = { ...process.env, DS_AGENT_HOME: stateHome, NODE_NO_WARNINGS: '1' }
    for (const key of [
      'DS_AGENT_IMESSAGE_HANDLE',
      'DS_AGENT_ACTOR_ALLOWLIST',
      'DS_AGENT_IMESSAGE_ALLOW_ANY',
      'DS_AGENT_IMESSAGE_ALLOW_GROUPS',
      'DS_AGENT_IMESSAGE_DB',
      'DS_AGENT_IMESSAGE_SINCE',
      'DS_AGENT_IMESSAGE_INTERVAL_MS',
    ]) {
      delete env[key]
    }

    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli/main.ts', 'serve', '--imessage', '--db', dbPath],
      { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    children.push(child)
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })

    const [code] = await withTimeout(
      once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>,
      20_000,
    )
    expect(code).toBe(1)
    expect(stderr).toContain('refuses to start without a sender allowlist')
    expect(stderr).toContain('--handle "+..."')
    // Neither the permissioned chat.db nor the state directory was created.
    expect(fs.existsSync(dbPath)).toBe(false)
    expect(fs.existsSync(stateHome)).toBe(false)
    expect(fs.existsSync(path.join(dir, 'ds-agent'))).toBe(false)
  }, 30_000)
})

describe('resolveImessageCliConfig', () => {
  it('shares chat admission and flags with serve', () => {
    const denied = resolveImessageCliConfig(
      ['node', 'ds-agent', 'serve', '--imessage'],
      {},
    )
    expect(denied.admission.allowed).toBe(false)
    expect(denied.admission.error).toContain('DS_AGENT_ACTOR_ALLOWLIST')

    const allowed = resolveImessageCliConfig(
      ['node', 'ds-agent', 'serve', '--imessage', '--handle', ' +15550000000 ', '--allow-groups'],
      {},
    )
    expect(allowed.handle).toBe('+15550000000')
    expect(allowed.allowGroups).toBe(true)
    expect(allowed.admission.allowed).toBe(true)
    expect(allowed.admission.senders).toEqual(['+15550000000'])
  })
})

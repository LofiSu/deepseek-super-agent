import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FeishuClient } from '../src/channels/feishu.ts'
import {
  resolveFeishuCliConfig,
  runFeishuLoop,
  type FeishuLoopSource,
} from '../src/cli/feishu.ts'
import { MockModel } from '../src/harness/model.ts'
import { Runtime } from '../src/runtime.ts'
import type { Trigger } from '../src/shared/types.ts'

/**
 * Offline coverage for `serve --feishu`. No Feishu network call is possible:
 * the outbox client uses a fetch that throws, and the inbound source is a fake.
 * The Runtime is driven by MockModel over a temp DS_AGENT_HOME.
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

function makeRuntime(home = tempDir('ds-agent-serve-feishu-home-')): Runtime {
  homes.push(home)
  const runtime = Runtime.create({
    home,
    model: new MockModel(),
    jobDelayMs: 0,
    watchdogIntervalMs: 60_000,
    // Admitting by chat id proves the Feishu trigger's address.group survives
    // into normal admission; the loop does not bypass the filter.
    env: { ...process.env, DS_AGENT_GROUP_ALLOWLIST: 'oc_test' },
  })
  runtime.start()
  runtimes.push(runtime)
  return runtime
}

/** A client that would fail loudly if any test reached the network. */
function noNetworkClient(): FeishuClient {
  return new FeishuClient(
    { appId: 'app', appSecret: 'secret', baseUrl: 'https://open.feishu.cn' },
    async () => {
      throw new Error('network disabled in tests')
    },
  )
}

function trigger(id: string, createTimeMs: number, text = '@ds-agent please fix the login timeout'): Trigger {
  return {
    id: `feishu_${id}`,
    source: 'im',
    threads: [{ source: 'im', id: 'feishu:oc_test' }],
    actor: { source: 'im', id: 'ou_alice' },
    human: true,
    addressed: 'mention',
    at: new Date(createTimeMs).toISOString(),
    text,
    channel: {
      source: 'im',
      thread: 'feishu:oc_test',
      address: {
        provider: 'feishu',
        chat_id: 'oc_test',
        group: 'oc_test',
        message_id: id,
      },
    },
    meta: {
      provider: 'feishu',
      chat_id: 'oc_test',
      message_id: id,
      msg_type: 'text',
      sender_type: 'user',
    },
  }
}

/**
 * Fake inbound source. `failFirst` pulls throw; a successful pull delivers the
 * seeded triggers once, then waits empty like a poll over an unchanged chat.
 */
class FakeFeishuSource implements FeishuLoopSource {
  pulls = 0
  private cursor = 0
  private delivered = false

  constructor(
    private readonly messages: readonly Trigger[] = [],
    private readonly failFirst = 0,
  ) {}

  get cursorMs(): number {
    return this.cursor
  }

  async pull(): Promise<readonly Trigger[]> {
    this.pulls += 1
    if (this.pulls <= this.failFirst) throw new Error(`pull failed #${this.pulls}`)
    if (this.delivered) return []
    this.delivered = true
    for (const item of this.messages) {
      this.cursor = Math.max(this.cursor, Date.parse(item.at))
    }
    return this.messages
  }
}

function spyIngest(runtime: Runtime): Trigger[] {
  const ingested: Trigger[] = []
  const original = runtime.ingestAsync.bind(runtime)
  runtime.ingestAsync = (incoming: Trigger) => {
    ingested.push(incoming)
    return original(incoming)
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

function cliEnv(stateHome: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DS_AGENT_HOME: stateHome, NODE_NO_WARNINGS: '1' }
  for (const key of [
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_CHAT_ID',
    'FEISHU_BASE_URL',
    'FEISHU_INTERVAL_MS',
    'FEISHU_SINCE',
    'DS_AGENT_IMESSAGE_HANDLE',
    'DS_AGENT_ACTOR_ALLOWLIST',
    'DS_AGENT_GROUP_ALLOWLIST',
  ]) {
    delete env[key]
  }
  return { ...env, ...overrides }
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

describe('serve --feishu loop', () => {
  it('seeds from --since, ingests, and persists the advanced ms cursor', async () => {
    const runtime = makeRuntime()
    const ingested = spyIngest(runtime)
    const source = new FakeFeishuSource([trigger('om_1', 1_761_958_800_000)])
    const seeds: (number | undefined)[] = []

    const reason = await runFeishuLoop({
      runtime,
      chatId: 'oc_test',
      client: noNetworkClient(),
      createSource: seed => {
        seeds.push(seed)
        return source
      },
      since: 1_761_958_000_000,
      intervalMs: 5,
      once: true,
    })

    expect(reason).toBe('once')
    expect(seeds).toEqual([1_761_958_000_000])
    expect(ingested.map(item => item.id)).toEqual(['feishu_om_1'])
    expect(logText(runtime)).toContain('[feishu] inbound id=feishu_om_1')
    expect(runtime.store.getDoc<{ chatId: string; lastCreateTimeMs: number }>('feishu_cursor', 'cursor'))
      .toEqual({ chatId: 'oc_test', lastCreateTimeMs: 1_761_958_800_000 })
  })

  it('uses the source default on first run, then resumes from SQLite without replay', async () => {
    const home = tempDir('ds-agent-serve-feishu-restart-')
    const first = makeRuntime(home)
    const firstSeeds: (number | undefined)[] = []
    const firstIngest = spyIngest(first)

    await runFeishuLoop({
      runtime: first,
      chatId: 'oc_test',
      client: noNetworkClient(),
      createSource: seed => {
        firstSeeds.push(seed)
        return new FakeFeishuSource([trigger('om_1', 1_761_958_800_000)])
      },
      intervalMs: 5,
      once: true,
    })

    expect(firstSeeds).toEqual([undefined])
    expect(firstIngest.map(item => item.id)).toEqual(['feishu_om_1'])
    expect(first.store.getDoc('feishu_cursor', 'cursor'))
      .toEqual({ chatId: 'oc_test', lastCreateTimeMs: 1_761_958_800_000 })
    await first.finish()

    // A fresh process (new Runtime) on the same SQLite reads the stored cursor.
    const second = makeRuntime(home)
    const secondSeeds: (number | undefined)[] = []
    const secondIngest = spyIngest(second)

    await runFeishuLoop({
      runtime: second,
      chatId: 'oc_test',
      client: noNetworkClient(),
      createSource: seed => {
        secondSeeds.push(seed)
        return new FakeFeishuSource([])
      },
      intervalMs: 5,
      once: true,
    })

    expect(secondSeeds).toEqual([1_761_958_800_000])
    expect(secondIngest).toEqual([])
    // The persisted window did not move or replay on restart.
    expect(second.store.getDoc('feishu_cursor', 'cursor'))
      .toEqual({ chatId: 'oc_test', lastCreateTimeMs: 1_761_958_800_000 })
  })

  it('ignores a stored cursor for a different chat', async () => {
    const runtime = makeRuntime()
    runtime.store.putDoc('feishu_cursor', 'cursor', { chatId: 'oc_other', lastCreateTimeMs: 9_999 })
    const seeds: (number | undefined)[] = []

    await runFeishuLoop({
      runtime,
      chatId: 'oc_test',
      client: noNetworkClient(),
      createSource: seed => {
        seeds.push(seed)
        return new FakeFeishuSource([])
      },
      intervalMs: 5,
      once: true,
    })

    expect(seeds).toEqual([undefined])
  })

  it('retries a failing pull with bounded backoff and recovers', async () => {
    const runtime = makeRuntime()
    const ingested = spyIngest(runtime)
    const source = new FakeFeishuSource([trigger('om_1', 1_761_958_800_000)], 1)
    const controller = new AbortController()

    const loop = runFeishuLoop({
      runtime,
      chatId: 'oc_test',
      client: noNetworkClient(),
      createSource: () => source,
      intervalMs: 5,
      maxBackoffMs: 20,
      signal: controller.signal,
    })

    await waitFor(() => ingested.length === 1)
    expect(source.pulls).toBeGreaterThanOrEqual(2)
    expect(logText(runtime)).toContain('[feishu] poll error pull failed #1')
    expect(ingested.map(item => item.id)).toEqual(['feishu_om_1'])

    controller.abort()
    await withTimeout(loop, 1_000)
  })

  it('stops promptly when aborted and leaves no pending poll timer', async () => {
    const runtime = makeRuntime()
    const source = new FakeFeishuSource([])
    const controller = new AbortController()

    const loop = runFeishuLoop({
      runtime,
      chatId: 'oc_test',
      client: noNetworkClient(),
      createSource: () => source,
      intervalMs: 5,
      signal: controller.signal,
    })

    await waitFor(() => source.pulls >= 2)
    controller.abort()
    const reason = await withTimeout(loop, 1_000)
    expect(reason).toBe('aborted')

    const settledPulls = source.pulls
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(source.pulls).toBe(settledPulls)
  })
})

describe('resolveFeishuCliConfig', () => {
  it('requires app credentials before any Runtime exists', () => {
    expect(() => resolveFeishuCliConfig(['node', 'ds-agent', 'serve', '--feishu'], {}))
      .toThrow(/FEISHU_APP_ID and FEISHU_APP_SECRET/)
    expect(() => resolveFeishuCliConfig(
      ['node', 'ds-agent', 'serve', '--feishu'],
      { FEISHU_APP_ID: 'app' },
    )).toThrow(/set together/)
  })

  it('requires a poll target from --chat or FEISHU_CHAT_ID', () => {
    const creds = { FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret' }
    expect(() => resolveFeishuCliConfig(['node', 'ds-agent', 'serve', '--feishu'], creds))
      .toThrow(/poll target chat/)
    expect(() => resolveFeishuCliConfig(
      ['node', 'ds-agent', 'serve', '--feishu', '--chat', '--once'],
      creds,
    )).toThrow(/needs a non-empty chat id/)
  })

  it('parses --chat/--interval/--since/--once and clamps the interval', () => {
    const config = resolveFeishuCliConfig(
      [
        'node', 'ds-agent', 'serve', '--feishu',
        '--chat', ' oc_cli ',
        '--interval', '50',
        '--since', '1761958000000',
        '--once',
      ],
      {
        FEISHU_APP_ID: 'app',
        FEISHU_APP_SECRET: 'secret',
        FEISHU_CHAT_ID: 'oc_env',
      },
    )
    expect(config.chatId).toBe('oc_cli')
    expect(config.config.chatId).toBe('oc_cli')
    expect(config.intervalMs).toBe(1_000)
    expect(config.since).toBe(1_761_958_000_000)
    expect(config.once).toBe(true)
  })

  it('falls back to FEISHU_CHAT_ID and the default interval', () => {
    const config = resolveFeishuCliConfig(
      ['node', 'ds-agent', 'serve', '--feishu'],
      { FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', FEISHU_CHAT_ID: ' oc_env ' },
    )
    expect(config.chatId).toBe('oc_env')
    expect(config.intervalMs).toBe(2_000)
    expect(config.since).toBeNaN()
    expect(config.once).toBe(false)
  })
})

describe('serve --feishu refusal', () => {
  it('refuses before creating SQLite when app credentials are missing', async () => {
    const dir = tempDir('ds-agent-serve-feishu-deny-')
    const stateHome = path.join(dir, 'state')

    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli/main.ts', 'serve', '--feishu', '--chat', 'oc_test'],
      { cwd: process.cwd(), env: cliEnv(stateHome), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    children.push(child)
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })

    const [code] = await withTimeout(
      once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>,
      20_000,
    )
    expect(code).toBe(1)
    expect(stderr).toContain('serve --feishu needs FEISHU_APP_ID and FEISHU_APP_SECRET')
    expect(fs.existsSync(stateHome)).toBe(false)
    expect(fs.existsSync(path.join(dir, 'ds-agent'))).toBe(false)
  }, 30_000)

  it('fails closed before creating SQLite when a combined serve channel is unconfigured', async () => {
    const dir = tempDir('ds-agent-serve-both-')
    const stateHome = path.join(dir, 'state')

    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli/main.ts', 'serve', '--imessage', '--feishu'],
      { cwd: process.cwd(), env: cliEnv(stateHome), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    children.push(child)
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })

    const [code] = await withTimeout(
      once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>,
      20_000,
    )
    expect(code).toBe(1)
    expect(stderr).toContain('cannot start both inbound channels')
    expect(stderr).toContain('iMessage:')
    expect(stderr).toContain('Feishu:')
    expect(fs.existsSync(stateHome)).toBe(false)
  }, 30_000)

  it('reports missing Feishu config before SQLite even when iMessage is valid', async () => {
    const dir = tempDir('ds-agent-serve-both-feishu-missing-')
    const stateHome = path.join(dir, 'state')

    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli/main.ts', 'serve', '--imessage', '--feishu', '--handle', '+15550000000'],
      { cwd: process.cwd(), env: cliEnv(stateHome), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    children.push(child)
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })

    const [code] = await withTimeout(
      once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>,
      20_000,
    )
    expect(code).toBe(1)
    expect(stderr).toContain('cannot start both inbound channels')
    expect(stderr).toContain('FEISHU_APP_ID and FEISHU_APP_SECRET')
    expect(fs.existsSync(stateHome)).toBe(false)
  }, 30_000)
})

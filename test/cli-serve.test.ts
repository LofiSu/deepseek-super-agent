import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MockModel } from '../src/harness/model.ts'
import { Runtime } from '../src/runtime.ts'
import type { Thread, Trigger } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'

/**
 * Child-process coverage for `ds-agent serve`. The daemon must boot without a
 * provider key (the runtime's normal factory falls back to MockModel), log a
 * ready line, and drain through Runtime.finish() on SIGINT/SIGTERM.
 */

const homes: string[] = []
const children: ChildProcess[] = []

/** Mirrors the offline CI gate so an idle daemon never reaches a live endpoint. */
const OFFLINE_KEYS = [
  'DS_AGENT_API_BASE',
  'DS_AGENT_API_KEY',
  'DS_AGENT_API_MODEL',
  'DS_AGENT_PROVIDER',
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'GROK_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'ZHIPU_API_KEY',
  'GLM_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'ANTHROPIC_API_KEY',
]

interface RunningServe {
  child: ChildProcess
  out: string[]
  err: string[]
}

function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-serve-'))
  homes.push(dir)
  return dir
}

function offlineEnv(stateHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DS_AGENT_HOME: stateHome,
    NODE_NO_WARNINGS: '1',
  }
  for (const key of OFFLINE_KEYS) delete env[key]
  return env
}

function startServe(stateHome: string, extraEnv: NodeJS.ProcessEnv = {}): RunningServe {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli/main.ts', 'serve'],
    {
      cwd: process.cwd(),
      env: { ...offlineEnv(stateHome), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const running: RunningServe = { child, out: [], err: [] }
  child.stdout?.on('data', chunk => running.out.push(String(chunk)))
  child.stderr?.on('data', chunk => running.err.push(String(chunk)))
  children.push(child)
  return running
}

function text(lines: string[]): string {
  return lines.join('')
}

async function waitFor(running: RunningServe, needle: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (text(running.out).includes(needle)) return
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      throw new Error(
        `serve exited before "${needle}" code=${running.child.exitCode} signal=${running.child.signalCode}\n`
        + `stdout:\n${text(running.out)}\nstderr:\n${text(running.err)}`,
      )
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(
    `timed out waiting for "${needle}"\nstdout:\n${text(running.out)}\nstderr:\n${text(running.err)}`,
  )
}

async function waitForExit(
  running: RunningServe,
  timeoutMs = 20_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (running.child.exitCode !== null) {
    return { code: running.child.exitCode, signal: running.child.signalCode }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(
      `serve did not exit\nstdout:\n${text(running.out)}\nstderr:\n${text(running.err)}`,
    )), timeoutMs)
  })
  try {
    const exited = once(running.child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
    const [code, signal] = await Promise.race([exited, timeout])
    return { code, signal }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * Seed what the deterministic Gate leaves behind: a human, unaddressed trigger
 * deferred to the Main Agent, with a live pending queue and `deferred: true`.
 */
function seedDeferred(state: string): { threadKey: string; triggerId: string } {
  const at = '2026-11-02T00:00:00.000Z'
  const trigger: Trigger = {
    id: 'trg_deferred',
    source: 'im',
    threads: [{ source: 'im', id: 'topic/deferred' }],
    actor: { source: 'im', id: 'human-1' },
    human: true,
    at,
    text: 'please look into the flaky checkout test',
    meta: {},
  }
  const thread: Thread = {
    key: 'im:topic/deferred',
    ref: { source: 'im', id: 'topic/deferred' },
    createdAt: at,
    lastAt: at,
    subscriptions: [],
    correlated: [],
    pending: [trigger.id],
    deferred: true,
    meta: {},
  }
  const store = new Store(state)
  try {
    store.putDoc('trigger', trigger.id, trigger)
    store.putDoc('thread', thread.key, thread)
  } finally {
    store.close()
  }
  return { threadKey: thread.key, triggerId: trigger.id }
}

describe('ds-agent serve', () => {
  it('starts without a provider key and exits 0 on SIGTERM with SQLite usable', async () => {
    const state = home()
    const running = startServe(state)
    await waitFor(running, 'ds-agent serve ready')

    const ready = text(running.out)
    expect(ready).toContain(`home=${state}`)
    expect(ready).toContain('model=MockModel')

    // The daemon keeps the DB open in WAL mode; an offline health read must work.
    const health = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli/main.ts', 'health'],
      { cwd: process.cwd(), env: offlineEnv(state), encoding: 'utf8' },
    )
    expect(health.status, health.stderr).toBe(0)
    expect(JSON.parse(health.stdout)).toMatchObject({ store: 'ok' })

    const exited = waitForExit(running)
    running.child.kill('SIGTERM')
    const exit = await exited
    expect(exit.signal).toBeNull()
    expect(exit.code).toBe(0)
    expect(text(running.out)).toContain('[serve] stopped')

    // finish() checkpointed and closed WAL; the file is writable by the next process.
    const store = new Store(state)
    try {
      expect(store.health()).toBe('ok')
      store.putDoc('ticket', 'ticket_after_stop', {
        id: 'ticket_after_stop',
        title: 'after shutdown',
      })
      expect(store.getDoc<{ title: string }>('ticket', 'ticket_after_stop')?.title)
        .toBe('after shutdown')
    } finally {
      store.close()
    }
  })

  it('exits 0 on SIGINT', async () => {
    const running = startServe(home())
    await waitFor(running, 'ds-agent serve ready')

    const exited = waitForExit(running)
    running.child.kill('SIGINT')
    const exit = await exited
    expect(exit.signal).toBeNull()
    expect(exit.code).toBe(0)
  })

  it('leaves Gate-deferred work queued when started without a live model', async () => {
    const state = home()
    const seeded = seedDeferred(state)
    const running = startServe(state)
    await waitFor(running, 'ds-agent serve ready')
    expect(text(running.out))
      .toContain('[serve] MockModel: deferred assessments left queued until a live-model start')

    const exited = waitForExit(running)
    running.child.kill('SIGTERM')
    const exit = await exited
    expect(exit.signal).toBeNull()
    expect(exit.code).toBe(0)

    const store = new Store(state)
    try {
      const thread = store.getDoc<Thread>('thread', seeded.threadKey)
      expect(thread?.pending).toEqual([seeded.triggerId])
      expect(thread?.deferred).toBe(true)
      // No assessment consumed the trigger: no disposition, eval decision, or ticket.
      expect(store.getDoc('disposition', seeded.triggerId)).toBeUndefined()
      expect(store.listDocs('decision')).toHaveLength(0)
      expect(store.listDocs('ticket')).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('force-exits 1 on a second signal when the drain hangs', async () => {
    const state = home()
    seedDeferred(state)
    // Accept the assessment request but never answer it, so finish() waits.
    const server = createServer(() => { /* hold the socket open */ })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address() as AddressInfo
      const running = startServe(state, {
        DS_AGENT_API_BASE: `http://127.0.0.1:${address.port}/v1`,
        DS_AGENT_API_KEY: 'test-key',
        DS_AGENT_API_MODEL: 'test-model',
      })
      await waitFor(running, 'ds-agent serve ready')
      expect(text(running.out)).toContain('model=HttpOpenAI')

      running.child.kill('SIGTERM')
      await waitFor(running, '[serve] shutdown signal=SIGTERM')
      running.child.kill('SIGTERM')
      const exit = await waitForExit(running)
      expect(exit.signal).toBeNull()
      expect(exit.code).toBe(1)
      expect(text(running.out)).toContain('[serve] second signal=SIGTERM; force exit')
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('stops the daemon and closes SQLite when a drain step rejects', async () => {
    const runtime = Runtime.create({
      home: home(),
      model: new MockModel(),
      watchdogIntervalMs: 60_000,
    })
    runtime.start()
    runtime.harness.jobsSettled = () => Promise.reject(new Error('injected drain failure'))

    await expect(runtime.finish()).rejects.toThrow('injected drain failure')
    expect(runtime.store.isOpen).toBe(false)
    expect(runtime.log.text()).toContain('[daemon] stop')
  })
})

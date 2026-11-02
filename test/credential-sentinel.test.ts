import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { bindRolePorts } from '../src/core/role-ports.ts'
import { ToolRegistry } from '../src/harness/tools.ts'
import { MockModel, type Completion, type CompletionRequest } from '../src/harness/model.ts'
import type { Runtime } from '../src/runtime.ts'
import type { EnvPort } from '../src/shared/ports.ts'
import type { Ticket } from '../src/shared/types.ts'
import { freshRuntime, settleWithDeadline, shutdown, tempHome } from './fixtures.ts'

/**
 * P0-5 / PLAN D13: a credential value must never reach a durable or outbound
 * artifact. The unique sentinel is known to the Runtime only through the env
 * (the same way a real DS_AGENT_API_KEY enters), then is deliberately repeated
 * in the ticket text so every redaction boundary is exercised: ingress spill,
 * trigger/ticket documents, model prompts, tool output (read_object), session
 * journal (SQLite + JSONL), replies/outbox, events, and the SQLite file itself.
 */
class CapturingMockModel extends MockModel {
  readonly requests: CompletionRequest[] = []

  override async complete(request: CompletionRequest): Promise<Completion> {
    this.requests.push(structuredClone(request))
    return super.complete(request)
  }
}

const runtimes: Runtime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    runtime.daemon.stop()
    if (runtime.store.isOpen) runtime.store.close()
  }
})

function baseEnv(sentinel: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LANG: process.env.LANG,
    TMPDIR: process.env.TMPDIR,
    DS_AGENT_API_KEY: sentinel,
  }
}

function runtimeFor(model: MockModel, sentinel: string): Runtime {
  const runtime = freshRuntime({
    home: tempHome(),
    model,
    env: baseEnv(sentinel),
    jobDelayMs: 0,
    watchdogIntervalMs: 60_000,
    stuckMs: 60_000,
  })
  runtimes.push(runtime)
  return runtime
}

function filesUnder(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  walk(root)
  return files
}

/** Query every table so a column added later is covered without editing this test. */
function sqliteTables(dbPath: string): { name: string; rows: unknown[] }[] {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as { name: string }[]
    return tables.map(({ name }) => ({
      name,
      rows: db.prepare(`SELECT * FROM "${name}"`).all() as unknown[],
    }))
  } finally {
    db.close()
  }
}

describe('credential sentinel non-leakage (P0-5/D13)', () => {
  it('never persists or sends a DS_AGENT_API_KEY sentinel through a ticket', async () => {
    const sentinel = `sk-sentinel-${randomUUID()}`
    const model = new CapturingMockModel()
    const runtime = runtimeFor(model, sentinel)
    const padding = 'The deploy log repeats the leaked value in CI output. '.repeat(4)
    const text = `@ds-agent please investigate the credential leak ${sentinel} in the deploy log and rotate it. ${padding}`

    // Non-vacuous: the raw ticket really contains the unique sentinel.
    expect(text).toContain(sentinel)
    expect(text.length).toBeGreaterThan(180)

    runtime.ingest(imTrigger({ id: 'trg_credential_sentinel', thread: 'topic/credential', text }))
    expect(await settleWithDeadline(runtime, 30_000)).toBe('settled')

    // --- In-memory read models before shutdown -----------------------------
    const messages = runtime.store.listMessages()
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.map(message => message.body).join('\n')).not.toContain(sentinel)

    const toolMessages = messages.filter(message => message.role === 'tool')
    expect(toolMessages.length).toBeGreaterThan(0)
    expect(toolMessages.map(message => message.body).join('\n')).not.toContain(sentinel)
    const readObject = toolMessages.find(message => message.body.includes('"name":"read_object"'))
    expect(readObject).toBeTruthy()
    // The worker read the ingress spill; its tool result was redacted before
    // being replayed to the model and persisted in the journal.
    expect(readObject!.body).toContain('[redacted]')

    const spillId = /spillId=(spill_\d+)/.exec(runtime.log.text())?.[1]
    expect(spillId).toBeTruthy()
    const spill = runtime.store.getSpill(spillId!) ?? ''
    expect(spill).not.toContain(sentinel)
    expect(spill).toContain('[redacted]')

    const tickets = runtime.store.listDocs<Ticket>('ticket')
    expect(tickets).toHaveLength(1)
    expect(JSON.stringify(tickets)).not.toContain(sentinel)
    expect(JSON.stringify(runtime.store.listEvents())).not.toContain(sentinel)
    expect(JSON.stringify(runtime.store.listReplies())).not.toContain(sentinel)
    expect(JSON.stringify(runtime.store.listOutbox())).not.toContain(sentinel)
    // The reply/outbox path must actually have run, not be vacuously empty.
    expect(runtime.store.listReplies().length).toBeGreaterThan(0)
    expect(runtime.store.listOutbox().length).toBeGreaterThan(0)
    expect(runtime.log.text()).not.toContain(sentinel)

    // --- Outbound model I/O ------------------------------------------------
    expect(model.requests.length).toBeGreaterThan(0)
    expect(model.requests.some(request => request.role === 'router')).toBe(true)
    expect(model.requests.some(request => request.role === 'worker')).toBe(true)
    for (const request of model.requests) {
      // This is the body a provider would serialize; auth headers are separate.
      expect(JSON.stringify(request)).not.toContain(sentinel)
    }

    // --- Worker tool surface excludes reply/decide/receive -----------------
    const workerTools = new Set(
      model.requests
        .filter(request => request.role === 'worker')
        .flatMap(request => request.tools.map(tool => tool.name)),
    )
    const routerTools = new Set(
      model.requests
        .filter(request => request.role === 'router')
        .flatMap(request => request.tools.map(tool => tool.name)),
    )
    for (const name of [
      'reply_user',
      'assess_trigger',
      'list_tasks',
      'create_worker',
      'stop_worker',
      'subscribe_worker',
      'unsubscribe_worker',
      'nudge_worker',
      'mark_task_failed',
    ]) {
      expect(workerTools.has(name)).toBe(false)
    }
    // The real names exist on the Router surface, so the exclusion is meaningful.
    expect(routerTools.has('reply_user')).toBe(true)
    expect(routerTools.has('assess_trigger')).toBe(true)

    // --- Durable artifacts: close, then scan every file and table ----------
    const home = runtime.home
    await shutdown(runtime)
    const files = filesUnder(home)
    expect(files.some(file => file.endsWith('.jsonl'))).toBe(true)
    for (const file of files) {
      const bytes = fs.readFileSync(file)
      expect(bytes.includes(Buffer.from(sentinel)), `sentinel leaked into ${file}`).toBe(false)
    }

    const tables = sqliteTables(runtime.store.path)
    expect(tables.map(table => table.name)).toEqual(expect.arrayContaining([
      'messages', 'spills', 'events', 'documents', 'replies', 'outbox', 'sessions',
    ]))
    for (const table of tables) {
      expect(JSON.stringify(table.rows), `sentinel leaked into sqlite table ${table.name}`)
        .not.toContain(sentinel)
    }
    const spills = tables.find(table => table.name === 'spills')?.rows ?? []
    expect(spills.length).toBeGreaterThan(0)
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('does not expose reply/decide/receive tools or ports to the Worker role', () => {
    const sentinel = `sk-sentinel-${randomUUID()}`
    const runtime = runtimeFor(new CapturingMockModel(), sentinel)
    const tools = new ToolRegistry({
      store: runtime.store,
      ports: bindRolePorts(runtime.engine),
      env: {} as EnvPort,
      metrics: runtime.metrics,
      redact: text => text,
      log: () => {},
      scheduleJob: () => {},
      routerTurn: async () => {},
    })

    const workerTools = tools.specsFor('worker').map(tool => tool.name)
    for (const name of ['reply_user', 'assess_trigger', 'list_tasks', 'create_worker', 'stop_worker']) {
      expect(workerTools).not.toContain(name)
    }
    const routerTools = tools.specsFor('router').map(tool => tool.name)
    expect(routerTools).toEqual(expect.arrayContaining(['reply_user', 'assess_trigger']))

    const workerSession = { sessionId: 'worker_ticket_1', role: 'worker' as const }
    return Promise.all([
      expect(tools.invoke(
        { id: 'deny_reply', name: 'reply_user', args: { ticketId: 'ticket_1', text: 'x', purpose: 'result' } },
        workerSession,
      )).rejects.toThrow(/not available to worker/),
      expect(tools.invoke(
        { id: 'deny_assess', name: 'assess_trigger', args: { triggerId: 'trg_1', kind: 'accept', reason: 'x' } },
        workerSession,
      )).rejects.toThrow(/not available to worker/),
    ]).then(() => {
      const sealedWorker = bindRolePorts(runtime.engine).worker as unknown as {
        reply(): void
        decide(): void
        receive(): void
      }
      expect(() => sealedWorker.reply()).toThrow(/worker cannot reply/)
      expect(() => sealedWorker.decide()).toThrow(/worker cannot decide/)
      expect(() => sealedWorker.receive()).toThrow(/worker cannot receive/)
    })
  })
})

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { githubTrigger } from '../src/channels/github.ts'
import { imTrigger } from '../src/channels/im.ts'
import { Engine } from '../src/core/engine.ts'
import { bindRolePorts } from '../src/core/role-ports.ts'
import type { Host } from '../src/core/host.ts'
import { LocalEnv } from '../src/env/local-env.ts'
import { ToolRegistry } from '../src/harness/tools.ts'
import { Metrics } from '../src/metrics/metrics.ts'
import { workerSessionId } from '../src/harness/session.ts'
import { HeuristicDeliverGate, maySurface } from '../src/speculate/gate.ts'
import { visibleTickets } from '../src/speculate/index.ts'
import type { EnvPort } from '../src/shared/ports.ts'
import type { Ticket } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'
import { tempHome } from './fixtures.ts'

const open: Store[] = []

afterEach(() => {
  for (const store of open.splice(0)) {
    if (store.isOpen) store.close()
  }
})

function hostFor(store: Store, lines: string[]): Host {
  return {
    repo: store,
    now: () => '2026-10-31T00:00:00.000Z',
    log: line => lines.push(line),
    metrics: new Metrics(path.dirname(store.path)),
    scope: { admit: () => ({ listened: true, reason: 'test' }) },
  }
}

function openStore(): { store: Store; lines: string[]; engine: Engine } {
  const store = new Store(tempHome())
  open.push(store)
  const lines: string[] = []
  return { store, lines, engine: new Engine(hostFor(store, lines)) }
}

function speculativeTicket(engine: Engine, store: Store, id = 'trg_maybe'): string {
  engine.receive(githubTrigger({
    id,
    pr: 7,
    text: 'might be a flaky payment test',
    speculate: true,
    at: '2026-10-31T00:00:00.000Z',
  }))
  const decision = engine.evaluateDue()[0]
  if (!decision?.ticketId) throw new Error('expected a ticket')
  const ticket = store.getDoc<Ticket>('ticket', decision.ticketId)
  if (!ticket) throw new Error('missing ticket')
  engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id, workerSessionId(ticket.id))
  return ticket.id
}

function ctx(ticketId: string) {
  return { sessionId: workerSessionId(ticketId), role: 'worker' as const, ticketId }
}

describe('DeliverGate', () => {
  const gate = new HeuristicDeliverGate()
  const speculative = { speculative: true } as Ticket
  const plain = { speculative: false } as Ticket

  it('discards failed and dropped reports and commits a valuable ready report', () => {
    expect(gate.evaluate({ ticket: speculative, report: { kind: 'failed', text: 'boom', deliver: true } })).toBe('discard')
    expect(gate.evaluate({ ticket: speculative, report: { kind: 'dropped', text: 'fixed', deliver: true } })).toBe('discard')
    expect(gate.evaluate({
      ticket: speculative,
      report: { kind: 'ready', text: 'still looking', deliver: false },
    })).toBe('discard')
    expect(gate.evaluate({
      ticket: speculative,
      report: { kind: 'ready', text: 'fixed the timeout', deliver: false },
    })).toBe('deliver')
    expect(gate.evaluate({
      ticket: speculative,
      report: { kind: 'ready', text: 'ready: investigation recorded', deliver: true },
    })).toBe('deliver')
    expect(gate.evaluate({ ticket: plain, report: { kind: 'ready', text: 'ok', deliver: true } })).toBe('deliver')
  })

  it('keeps speculative replies silent until deliver is true', () => {
    expect(maySurface(true, undefined)).toBe(false)
    expect(maySurface(true, false)).toBe(false)
    expect(maySurface(true, true)).toBe(true)
    expect(maySurface(false, undefined)).toBe(true)
    expect(maySurface(false, false)).toBe(false)
  })
})

describe('speculative discard', () => {
  it('ends the assignment and ticket, emits speculate.discarded, and writes no reply', () => {
    const { store, lines, engine } = openStore()
    const ticketId = speculativeTicket(engine, store)
    expect(store.listReplies()).toHaveLength(0)

    engine.reply(ticketId, 'should not leak', 'result')
    expect(store.listReplies()).toHaveLength(0)
    expect(lines.some(line => line.includes('reply held'))).toBe(true)

    const progress = engine.report(ticketId, { kind: 'progress', text: 'investigating quietly', deliver: false })
    expect(progress).toEqual({ surfaced: false, verdict: 'hold' })
    const mid = store.getDoc<Ticket>('ticket', ticketId)!
    expect(mid.ended).toBeUndefined()
    expect(mid.assignments[0]?.state).toBe('running')
    expect(store.listEvents().some(event => event.type === 'speculate.discarded')).toBe(false)

    const failed = engine.report(ticketId, { kind: 'failed', text: 'could not reproduce', deliver: true })
    expect(failed).toEqual({ surfaced: false, verdict: 'discard' })
    const ticket = store.getDoc<Ticket>('ticket', ticketId)!
    expect(ticket.speculative).toBe(true)
    expect(ticket.ended).toMatchObject({ outcome: 'discarded', by: 'watchdog' })
    expect(ticket.assignments[0]).toMatchObject({ state: 'ended' })
    expect(ticket.assignments[0]?.endedAt).toBeTruthy()

    const types = store.listEvents().map(event => event.type)
    expect(types).toContain('assignment.ended')
    expect(types).toContain('ticket.ended')
    expect(types).toContain('speculate.discarded')
    const discarded = store.listEvents().find(event => event.type === 'speculate.discarded')
    expect(discarded?.payload).toMatchObject({ ticketId, kind: 'failed' })

    engine.reply(ticketId, 'still hidden', 'result')
    expect(store.listReplies()).toHaveLength(0)
    expect(visibleTickets(store.listDocs<Ticket>('ticket'))).toHaveLength(0)
  })

  it('does not resume a discarded ticket', () => {
    const { store, engine } = openStore()
    const ticketId = speculativeTicket(engine, store)
    engine.report(ticketId, { kind: 'dropped', text: 'not ours', deliver: false })
    engine.receive({
      id: 'trg_follow',
      source: 'github',
      threads: [{ source: 'github', id: 'pr/7' }],
      actor: { source: 'github', id: 'alex' },
      human: true,
      addressed: 'mention',
      at: '2026-10-31T00:01:00.000Z',
      text: '@ds-agent any update on the flaky test',
      channel: { source: 'github', thread: 'pr/7' },
      meta: {},
    })
    const ticket = store.getDoc<Ticket>('ticket', ticketId)!
    expect(ticket.ended?.outcome).toBe('discarded')
    expect(store.listEvents().some(event => event.type === 'ticket.resumed')).toBe(false)
  })

  it('commits a valuable ready report and then allows the reply', () => {
    const { store, engine } = openStore()
    const ticketId = speculativeTicket(engine, store, 'trg_value')
    const result = engine.report(ticketId, { kind: 'ready', text: 'fixed the timeout', deliver: false })
    expect(result).toEqual({ surfaced: true, verdict: 'deliver' })
    const ticket = store.getDoc<Ticket>('ticket', ticketId)!
    expect(ticket.speculative).toBe(false)
    expect(ticket.assignments[0]?.speculative).toBe(false)
    expect(ticket.assignments[0]?.state).toBe('ended')
    expect(ticket.ended?.outcome).toBe('ready')
    expect(store.listEvents().some(event => event.type === 'speculate.delivered')).toBe(true)
    expect(visibleTickets(store.listDocs<Ticket>('ticket')).map(item => item.id)).toEqual([ticketId])

    engine.reply(ticketId, 'Fixed the timeout.', 'result')
    expect(store.listReplies().map(reply => reply.purpose)).toEqual(['result'])
  })
})

describe('speculative workdir', () => {
  it('keeps bash and write in a scratch dir and deletes it on discard', async () => {
    const home = tempHome()
    const store = new Store(home)
    open.push(store)
    const lines: string[] = []
    const engine = new Engine(hostFor(store, lines))
    const env = new LocalEnv(path.join(home, 'workspaces'))
    const tools = new ToolRegistry({
      store,
      ports: bindRolePorts(engine),
      env,
      metrics: new Metrics(path.dirname(store.path)),
      redact: (text: string) => text,
      log: line => lines.push(line),
      scheduleJob: () => {},
      routerTurn: async () => {},
    })
    const ticketId = speculativeTicket(engine, store)
    const sessionId = workerSessionId(ticketId)
    const scratch = path.join(home, 'workspaces', 'speculative', sessionId)
    const durable = path.join(home, 'workspaces', sessionId)

    await tools.invoke(
      { id: 'w', name: 'write_file', args: { path: 'secret.txt', body: 'scratch-only' } },
      ctx(ticketId),
    )
    await tools.invoke(
      { id: 'b', name: 'bash', args: { command: 'echo from-bash > bash.txt' } },
      ctx(ticketId),
    )
    expect(fs.readFileSync(path.join(scratch, 'secret.txt'), 'utf8')).toBe('scratch-only')
    expect(fs.readFileSync(path.join(scratch, 'bash.txt'), 'utf8')).toBe('from-bash\n')
    expect(fs.existsSync(path.join(durable, 'secret.txt'))).toBe(false)

    await expect(env.bash(sessionId, 'echo hi > /tmp/ds-agent-speculative-escape', { isolated: true }))
      .rejects.toThrow(/isolated workdir/)
    expect(fs.existsSync('/tmp/ds-agent-speculative-escape')).toBe(false)

    const listed = await tools.invoke(
      { id: 'l', name: 'list_tasks', args: {} },
      { sessionId: 'router', role: 'router' },
    )
    expect(listed).toEqual([])

    await tools.invoke(
      { id: 'r', name: 'report_to_router', args: { ticketId, text: 'could not reproduce', deliver: false, kind: 'failed' } },
      ctx(ticketId),
    )
    expect(fs.existsSync(scratch)).toBe(false)
    expect(fs.existsSync(path.join(durable, 'secret.txt'))).toBe(false)
    const ticket = store.getDoc<Ticket>('ticket', ticketId)!
    expect(ticket.assignments[0]?.state).toBe('ended')
    expect(ticket.ended?.outcome).toBe('discarded')
    expect(store.listReplies()).toHaveLength(0)
    await expect(tools.invoke(
      { id: 'w2', name: 'write_file', args: { path: 'again.txt', body: 'nope' } },
      ctx(ticketId),
    )).rejects.toThrow(/discarded/)
  })

  it('promotes the scratch dir when the gate delivers', async () => {
    const home = tempHome()
    const store = new Store(home)
    open.push(store)
    const engine = new Engine(hostFor(store, []))
    const env = new LocalEnv(path.join(home, 'workspaces'))
    const tools = new ToolRegistry({
      store,
      ports: bindRolePorts(engine),
      env,
      metrics: new Metrics(path.dirname(store.path)),
      redact: (text: string) => text,
      log: () => {},
      scheduleJob: () => {},
      routerTurn: async () => {},
    })
    const ticketId = speculativeTicket(engine, store, 'trg_promote')
    const sessionId = workerSessionId(ticketId)
    await tools.invoke(
      { id: 'w', name: 'write_file', args: { path: 'notes.txt', body: 'promoted\n' } },
      ctx(ticketId),
    )
    await tools.invoke(
      {
        id: 'r',
        name: 'report_to_router',
        args: { ticketId, text: 'ready: investigation recorded', deliver: true, kind: 'ready' },
      },
      ctx(ticketId),
    )
    const durable = path.join(home, 'workspaces', sessionId, 'notes.txt')
    expect(fs.readFileSync(durable, 'utf8')).toBe('promoted\n')
    expect(fs.existsSync(path.join(home, 'workspaces', 'speculative', sessionId))).toBe(false)
    const ticket = store.getDoc<Ticket>('ticket', ticketId)!
    expect(ticket.speculative).toBe(false)
    engine.reply(ticketId, 'Recorded.', 'result')
    expect(store.listReplies()).toHaveLength(1)
    const listed = await tools.invoke(
      { id: 'l', name: 'list_tasks', args: {} },
      { sessionId: 'router', role: 'router' },
    ) as { id: string }[]
    expect(listed.map(item => item.id)).toEqual([ticketId])
  })

  it('refuses bash and write when a speculative worker has no isolated workdir', async () => {
    const { store, engine } = openStore()
    const ticketId = speculativeTicket(engine, store, 'trg_readonly')
    let mutations = 0
    const env: EnvPort = {
      async bash() {
        mutations += 1
        return { code: 0, stdout: '', stderr: '' }
      },
      async writeFile() {
        mutations += 1
        return '/tmp/should-not-write'
      },
      async readFile() {
        return ''
      },
    }
    const tools = new ToolRegistry({
      store,
      ports: bindRolePorts(engine),
      env,
      metrics: new Metrics(path.dirname(store.path)),
      redact: (text: string) => text,
      log: () => {},
      scheduleJob: () => {},
      routerTurn: async () => {},
    })
    await expect(tools.invoke(
      { id: 'b', name: 'bash', args: { command: 'echo leaked' } },
      ctx(ticketId),
    )).rejects.toThrow(/read-only/)
    await expect(tools.invoke(
      { id: 'w', name: 'write_file', args: { path: 'notes.txt', body: 'leaked' } },
      ctx(ticketId),
    )).rejects.toThrow(/read-only/)
    expect(mutations).toBe(0)
  })

  it('writes a normal worker into the durable workspace', async () => {
    const home = tempHome()
    const store = new Store(home)
    open.push(store)
    const lines: string[] = []
    const engine = new Engine(hostFor(store, lines))
    engine.receive(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout',
      at: '2026-10-31T00:00:00.000Z',
    }))
    const ticketId = engine.evaluateDue()[0]!.ticketId!
    const sessionId = workerSessionId(ticketId)
    engine.assignmentStarted(ticketId, store.getDoc<Ticket>('ticket', ticketId)!.assignments[0]!.id, sessionId)
    const env = new LocalEnv(path.join(home, 'workspaces'))
    const tools = new ToolRegistry({
      store,
      ports: bindRolePorts(engine),
      env,
      metrics: new Metrics(path.dirname(store.path)),
      redact: (text: string) => text,
      log: () => {},
      scheduleJob: () => {},
      routerTurn: async () => {},
    })
    await tools.invoke(
      { id: 'w', name: 'write_file', args: { path: 'notes.txt', body: 'durable' } },
      ctx(ticketId),
    )
    expect(fs.readFileSync(path.join(home, 'workspaces', sessionId, 'notes.txt'), 'utf8')).toBe('durable')
    expect(fs.existsSync(path.join(home, 'workspaces', 'speculative', sessionId, 'notes.txt'))).toBe(false)
  })
})

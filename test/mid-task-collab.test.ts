import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { Engine } from '../src/core/engine.ts'
import type { Host } from '../src/core/host.ts'
import { ticketStage } from '../src/core/stage.ts'
import { SessionJournal } from '../src/harness/session.ts'
import { Metrics } from '../src/metrics/metrics.ts'
import type { Ticket } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'
import { Watchdog } from '../src/watchdog/watchdog.ts'
import { tempHome } from './fixtures.ts'

const open: Store[] = []

afterEach(() => {
  for (const store of open.splice(0)) {
    if (store.isOpen) store.close()
  }
})

function tracked<T extends Store>(store: T): T {
  open.push(store)
  return store
}

function fabricate(overrides: Partial<Ticket> = {}): Ticket {
  const at = '2026-01-01T00:00:00.000Z'
  return {
    id: 'ticket_1',
    title: 'fix login timeout',
    brief: 'fix the login timeout on checkout',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-v1',
      scope: 'fix login timeout',
      actor: { source: 'cli', id: 'you' },
      basis: 'addressed',
    },
    threadKeys: ['cli:local'],
    channels: [{ source: 'cli', thread: 'local' }],
    inputs: [{
      id: 'input_1',
      kind: 'trigger',
      triggerId: 'trg_1',
      text: 'fix the login timeout on checkout',
      at,
      human: true,
    }],
    assignments: [{ id: 'asg_1', state: 'running', speculative: false, startedAt: at }],
    speculative: false,
    originTriggerId: 'trg_1',
    createdAt: at,
    ...overrides,
  }
}

function openEngine(home = tempHome()): { engine: Engine; store: Store; home: string; logs: string[] } {
  const store = tracked(new Store(home))
  const metrics = new Metrics(home)
  const logs: string[] = []
  const host: Host = {
    repo: store,
    now: () => new Date().toISOString(),
    metrics,
    log: line => logs.push(line),
    scope: { admit: () => ({ listened: true, reason: 'test' }) },
  }
  return { engine: new Engine(host), store, home, logs }
}

function putTicket(store: Store, ticket = fabricate()): Ticket {
  store.putDoc('ticket', ticket.id, ticket)
  return ticket
}

function runCli(home: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', ...args], {
    cwd: path.resolve('.'),
    env: { ...process.env, DS_AGENT_HOME: home },
    encoding: 'utf8',
  })
}

describe('mid-task collaboration domain', () => {
  it('pauses a ticket and persists the pause across a Store reopen', () => {
    const { engine, store, home } = openEngine()
    putTicket(store)

    const outcome = engine.pause('ticket_1', { reason: 'waiting on staging access' })
    expect(outcome.changed).toBe(true)
    expect(outcome.ticket.collab?.paused).toMatchObject({
      by: 'human',
      reason: 'waiting on staging access',
    })
    expect(ticketStage(outcome.ticket)).toBe('person/paused')
    // A second pause is a no-op rather than a second pause row.
    expect(engine.pause('ticket_1').changed).toBe(false)
    store.close()

    const reopened = tracked(new Store(home))
    const kept = reopened.getDoc<Ticket>('ticket', 'ticket_1')!
    expect(kept.collab?.paused?.reason).toBe('waiting on staging access')
    expect(reopened.listEvents().filter(event => event.type === 'ticket.paused')).toHaveLength(1)
  })

  it('intervene records guidance and pauses, then resume clears the pause and tracks delivery', () => {
    const { engine, store } = openEngine()
    putTicket(store)

    const intervened = engine.intervene('ticket_1', '  use the staging database only  ')
    expect(intervened.paused).toBe(true)
    expect(intervened.guidance.text).toBe('use the staging database only')
    expect(ticketStage(intervened.ticket)).toBe('person/paused')

    const resumed = engine.resume('ticket_1', { reason: 'human verified' })
    expect(resumed.resumed).toBe(true)
    expect(resumed.pausedAt).toBe(intervened.ticket.collab?.paused?.at)
    expect(resumed.ticket.collab?.paused).toBeUndefined()
    expect(resumed.ticket.collab?.resumes).toHaveLength(1)
    expect(resumed.ticket.collab?.resumes[0]).toMatchObject({
      by: 'human',
      reason: 'human verified',
      pausedAt: resumed.pausedAt,
    })

    expect(engine.takeGuidance('ticket_1', 'worker')).toEqual(['use the staging database only'])
    expect(engine.takeGuidance('ticket_1', 'worker')).toEqual([])
    expect(engine.takeGuidance('ticket_1', 'router')).toEqual(['use the staging database only'])
    const stored = store.getDoc<Ticket>('ticket', 'ticket_1')!
    expect(stored.collab?.guidance[0]?.seenByWorker).toBe(true)
    expect(stored.collab?.guidance[0]?.seenByRouter).toBe(true)
    expect(store.listEvents().some(event => event.type === 'collab.guidance_injected')).toBe(true)

    const again = engine.resume('ticket_1')
    expect(again.resumed).toBe(false)
  })

  it('refuses pause, intervene, and resume after the ticket ended', () => {
    const { engine, store } = openEngine()
    putTicket(store, fabricate({
      ended: { at: '2026-01-02T00:00:00.000Z', outcome: 'ready', by: 'executor' },
    }))
    expect(() => engine.pause('ticket_1')).toThrow(/has ended \(ready\); cannot pause/)
    expect(() => engine.intervene('ticket_1', 'try again')).toThrow(/has ended/)
    expect(() => engine.resume('ticket_1')).toThrow(/has ended/)
    expect(() => engine.pause('missing')).toThrow(/unknown ticket missing/)
  })

  it('holds worker reports and router replies while paused, then releases them after resume', () => {
    const { engine, store } = openEngine()
    putTicket(store)
    engine.pause('ticket_1', { reason: 'human review' })

    const held = engine.report('ticket_1', { kind: 'ready', text: 'fixed', deliver: true })
    expect(held).toEqual({ surfaced: false, verdict: 'hold' })
    expect(store.getDoc<Ticket>('ticket', 'ticket_1')?.ended).toBeUndefined()
    expect(store.listReplies()).toHaveLength(0)
    engine.reply('ticket_1', 'fixed, ready for review', 'result')
    expect(store.listReplies()).toHaveLength(0)
    expect(store.listEvents().some(event => event.type === 'collab.report_held')).toBe(true)
    expect(store.listEvents().some(event => event.type === 'collab.reply_held')).toBe(true)

    engine.resume('ticket_1')
    const released = engine.report('ticket_1', { kind: 'ready', text: 'fixed', deliver: true })
    expect(released.surfaced).toBe(true)
    engine.reply('ticket_1', 'fixed and verified', 'result')
    expect(store.getDoc<Ticket>('ticket', 'ticket_1')?.ended).toMatchObject({ outcome: 'ready' })
    expect(store.listReplies()).toHaveLength(1)
  })

  it('the watchdog treats a paused assignment as intentional idle, not stuck', () => {
    const { engine, store, home, logs } = openEngine()
    const ticket = putTicket(store, fabricate({
      assignments: [{
        id: 'asg_1',
        state: 'running',
        speculative: false,
        startedAt: '2020-01-01T00:00:00.000Z',
      }],
    }))
    engine.pause(ticket.id, { reason: 'lunch' })
    const watchdog = new Watchdog({
      store,
      engine,
      journal: new SessionJournal(path.join(home, 'sessions'), store, () => {}),
      log: line => logs.push(line),
      metrics: new Metrics(home),
      intervalMs: 60_000,
      stuckMs: 1_000,
    })

    watchdog.tick()
    expect(logs.join('\n')).toContain('stuck=0')
    expect(store.getDoc<Ticket>('ticket', ticket.id)?.ended).toBeUndefined()

    engine.resume(ticket.id)
    watchdog.tick()
    expect(logs.join('\n')).toContain('[watchdog] nudge')
  })
})

describe('mid-task collaboration CLI', () => {
  it('pause, intervene, collab, and tasks show a paused ticket without a model', () => {
    const home = tempHome()
    const store = tracked(new Store(home))
    putTicket(store)
    store.close()

    const paused = runCli(home, ['pause', 'ticket_1', '--reason', 'waiting on staging'])
    expect(paused.status, paused.stderr).toBe(0)
    expect(paused.stdout).toContain('paused ticket_1 "fix login timeout"')
    expect(paused.stdout).toContain('person/paused')
    expect(paused.stdout).toContain('pnpm ds-agent resume ticket_1')

    const intervened = runCli(home, ['intervene', 'ticket_1', 'use the staging database only'])
    expect(intervened.status, intervened.stderr).toBe(0)
    expect(intervened.stdout).toContain('guidance guide_1 added to ticket_1')
    expect(intervened.stdout).toContain('task is paused')

    const collab = runCli(home, ['collab', 'ticket_1'])
    expect(collab.status, collab.stderr).toBe(0)
    expect(collab.stdout).toContain('paused:')
    expect(collab.stdout).toContain('use the staging database only')
    expect(collab.stdout).toContain('[pending]')

    const tasks = runCli(home, ['tasks'])
    expect(tasks.status, tasks.stderr).toBe(0)
    expect(tasks.stdout).toContain('person/paused')

    const reopened = tracked(new Store(home))
    const kept = reopened.getDoc<Ticket>('ticket', 'ticket_1')!
    expect(kept.collab?.paused?.reason).toBe('waiting on staging')
    expect(kept.collab?.guidance).toHaveLength(1)
  })

  it('accepts a unique prefix and reports unknown or ended tickets clearly', () => {
    const home = tempHome()
    const store = tracked(new Store(home))
    putTicket(store)
    putTicket(store, fabricate({
      id: 'ticket_done',
      createdAt: '2026-02-01T00:00:00.000Z',
      ended: { at: '2026-02-02T00:00:00.000Z', outcome: 'ready', by: 'executor' },
    }))
    store.close()

    const prefix = runCli(home, ['pause', 'ticket_1'])
    expect(prefix.status, prefix.stderr).toBe(0)

    const ended = runCli(home, ['pause', 'ticket_done'])
    expect(ended.status).toBe(1)
    expect(ended.stderr).toContain('has ended (ready)')

    const unknown = runCli(home, ['pause', 'ticket_nope'])
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toContain('unknown ticket ticket_nope')
  })
})

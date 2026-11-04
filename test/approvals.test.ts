import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Engine } from '../src/core/engine.ts'
import type { Host } from '../src/core/host.ts'
import { ticketStage } from '../src/core/stage.ts'
import { bindRolePorts } from '../src/core/role-ports.ts'
import { LocalEnv } from '../src/env/local-env.ts'
import { ToolRegistry } from '../src/harness/tools.ts'
import { Metrics } from '../src/metrics/metrics.ts'
import type { Ticket } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'
import { imTrigger } from '../src/channels/im.ts'
import { freshRuntime, shutdown, tempHome } from './fixtures.ts'
import { ScriptedModel } from './scripted-model.ts'
import type { Runtime } from '../src/runtime.ts'

const stores: Store[] = []
const dirs: string[] = []
const runtimes: Runtime[] = []

function tracked(store: Store): Store {
  stores.push(store)
  return store
}

function fabricate(overrides: Partial<Ticket> = {}): Ticket {
  const at = '2026-01-01T00:00:00.000Z'
  return {
    id: 'ticket_1',
    title: 'publish the release',
    brief: 'publish the release notes',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-v1',
      scope: 'publish the release notes',
      actor: { source: 'cli', id: 'you' },
      basis: 'addressed',
    },
    threadKeys: ['cli:local'],
    channels: [{ source: 'cli', thread: 'local' }],
    inputs: [{
      id: 'input_1',
      kind: 'trigger',
      triggerId: 'trg_1',
      text: 'publish the release notes',
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
  const logs: string[] = []
  const host: Host = {
    repo: store,
    now: () => new Date().toISOString(),
    metrics: new Metrics(home),
    log: line => logs.push(line),
    scope: { admit: () => ({ listened: true, reason: 'test' }) },
  }
  return { engine: new Engine(host), store, home, logs }
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await shutdown(runtime)
  for (const store of stores.splice(0)) if (store.isOpen) store.close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('approval domain', () => {
  it('records a pending approval without pausing the ticket', () => {
    const { engine, store } = openEngine()
    store.putDoc('ticket', 'ticket_1', fabricate())

    const request = engine.requestApproval('ticket_1', {
      action: 'publish the release notes',
      reason: 'outward-facing',
      requestedBy: 'worker_ticket_1',
    })
    expect(request.approval).toMatchObject({
      action: 'publish the release notes',
      reason: 'outward-facing',
      status: 'pending',
      requestedBy: 'worker_ticket_1',
    })
    const ticket = store.getDoc<Ticket>('ticket', 'ticket_1')!
    expect(ticket.collab?.paused).toBeUndefined()
    expect(ticket.collab?.approvals?.[0]?.id).toBe(request.approval.id)
    expect(ticketStage(ticket)).toBe('person/approval')
    expect(store.listEvents().some(event => event.type === 'approval.requested')).toBe(true)
  })

  it('refuses a second pending approval for the same ticket', () => {
    const { engine, store } = openEngine()
    store.putDoc('ticket', 'ticket_1', fabricate())
    engine.requestApproval('ticket_1', { action: 'publish', requestedBy: 'worker' })
    expect(() => engine.requestApproval('ticket_1', { action: 'delete', requestedBy: 'worker' }))
      .toThrow(/already waiting for approval/)
  })

  it('approves, records guidance for the worker, and returns the ticket to work', () => {
    const { engine, store } = openEngine()
    store.putDoc('ticket', 'ticket_1', fabricate())
    const { approval } = engine.requestApproval('ticket_1', { action: 'publish', requestedBy: 'worker' })

    const decided = engine.decideApproval('ticket_1', approval.id, 'approved', { note: 'ship it' })
    expect(decided.approval.status).toBe('approved')
    expect(decided.approval.decidedAt).toBeTruthy()
    const ticket = store.getDoc<Ticket>('ticket', 'ticket_1')!
    expect(ticketStage(ticket)).not.toBe('person/approval')
    expect(ticket.collab?.resumes.at(-1)).toMatchObject({
      by: 'human',
      reason: `approval ${approval.id} approved`,
      pausedAt: approval.at,
    })
    expect(engine.takeGuidance('ticket_1', 'worker')).toEqual([
      `Approval ${approval.id} approved: publish. Note: ship it. Proceed with exactly that action.`,
    ])
    expect(store.listEvents().some(event => event.type === 'approval.decided')).toBe(true)
  })

  it('denies with guidance that forbids the action', () => {
    const { engine, store } = openEngine()
    store.putDoc('ticket', 'ticket_1', fabricate())
    const { approval } = engine.requestApproval('ticket_1', { action: 'delete the branch', requestedBy: 'worker' })

    engine.decideApproval('ticket_1', approval.id, 'denied', {})
    expect(engine.takeGuidance('ticket_1', 'worker')).toEqual([
      `Approval ${approval.id} denied: delete the branch. Do not perform it; report what you did instead and what you need.`,
    ])
  })

  it('refuses to decide an unknown or already-decided approval', () => {
    const { engine, store } = openEngine()
    store.putDoc('ticket', 'ticket_1', fabricate())
    expect(() => engine.decideApproval('ticket_1', 'appr_missing', 'approved'))
      .toThrow(/unknown approval/)
    const { approval } = engine.requestApproval('ticket_1', { action: 'publish', requestedBy: 'worker' })
    engine.decideApproval('ticket_1', approval.id, 'denied')
    expect(() => engine.decideApproval('ticket_1', approval.id, 'approved'))
      .toThrow(/already decided/)
  })

  it('treats an approval wait as intentional idle in the watchdog', async () => {
    const { engine, store, home, logs } = openEngine()
    store.putDoc('ticket', 'ticket_1', fabricate({
      assignments: [{
        id: 'asg_1',
        state: 'running',
        speculative: false,
        startedAt: '2020-01-01T00:00:00.000Z',
      }],
    }))
    engine.requestApproval('ticket_1', { action: 'publish', requestedBy: 'worker' })
    const { Watchdog } = await import('../src/watchdog/watchdog.ts')
    const { SessionJournal } = await import('../src/harness/session.ts')
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
    expect(store.getDoc<Ticket>('ticket', 'ticket_1')?.ended).toBeUndefined()
  })
})

describe('request_approval tool', () => {
  it('is worker-only, records the request, and asks the router to speak', async () => {
    const { engine, store } = openEngine()
    store.putDoc('ticket', 'ticket_1', fabricate())
    const prompts: string[] = []
    const tools = new ToolRegistry({
      store,
      ports: bindRolePorts(engine),
      env: new LocalEnv(path.join(tempHome(), 'workspaces')),
      metrics: new Metrics(tempHome()),
      redact: text => text,
      log: () => {},
      scheduleJob: () => {},
      routerTurn: async prompt => { prompts.push(prompt) },
    })
    expect(tools.specsFor('worker').map(spec => spec.name)).toContain('request_approval')
    expect(tools.specsFor('router').map(spec => spec.name)).not.toContain('request_approval')

    const result = await tools.invoke(
      {
        id: 'a1',
        name: 'request_approval',
        args: { action: 'publish the release notes', reason: 'outward-facing' },
      },
      { sessionId: 'worker_ticket_1', role: 'worker', ticketId: 'ticket_1' },
    ) as { approvalId: string; status: string }
    expect(result.status).toBe('pending')
    expect(store.getDoc<Ticket>('ticket', 'ticket_1')?.collab?.approvals?.[0]?.id).toBe(result.approvalId)
    expect(prompts.join('\n')).toContain('APPROVAL')
    expect(prompts.join('\n')).toContain(result.approvalId)
    expect(prompts.join('\n')).toContain('publish the release notes')
  })

  it('rejects the tool when the session has no ticket', async () => {
    const { engine, store } = openEngine()
    const tools = new ToolRegistry({
      store,
      ports: bindRolePorts(engine),
      env: new LocalEnv(path.join(tempHome(), 'workspaces')),
      metrics: new Metrics(tempHome()),
      redact: text => text,
      log: () => {},
      scheduleJob: () => {},
      routerTurn: async () => {},
    })
    await expect(tools.invoke(
      { id: 'a2', name: 'request_approval', args: { action: 'publish' } },
      { sessionId: 'worker_x', role: 'worker' },
    )).rejects.toThrow(/needs a ticket/)
  })
})

describe('approval CLI', () => {
  function runCli(home: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DS_AGENT_HOME: home,
        NODE_NO_WARNINGS: '1',
      },
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  function seed(home: string): string {
    const store = new Store(home)
    const ticket = fabricate({
      collab: {
        guidance: [],
        resumes: [],
        approvals: [{
          id: 'appr_1',
          at: '2026-01-01T00:01:00.000Z',
          action: 'publish the release notes',
          requestedBy: 'worker_ticket_1',
          status: 'pending',
        }],
      },
    })
    store.putDoc('ticket', ticket.id, ticket)
    store.close()
    return 'appr_1'
  }

  it('lists pending approvals', () => {
    const home = tempHome()
    dirs.push(home)
    seed(home)
    const result = runCli(home, ['approvals'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('ticket_1')
    expect(result.stdout).toContain('appr_1')
    expect(result.stdout).toContain('publish the release notes')
  })

  it('approves an approval and records the decision', () => {
    const home = tempHome()
    dirs.push(home)
    seed(home)
    const result = runCli(home, ['approve', 'ticket_1', 'appr_1', '--note', 'ship it'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('approved')
    const store = new Store(home)
    try {
      const ticket = store.getDoc<Ticket>('ticket', 'ticket_1')!
      expect(ticket.collab?.approvals?.[0]).toMatchObject({ status: 'approved', note: 'ship it' })
    } finally {
      store.close()
    }
  })

  it('denies an approval and records the decision', () => {
    const home = tempHome()
    dirs.push(home)
    seed(home)
    const result = runCli(home, ['deny', 'ticket_1', 'appr_1'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('denied')
    const store = new Store(home)
    try {
      expect(store.getDoc<Ticket>('ticket', 'ticket_1')?.collab?.approvals?.[0]?.status).toBe('denied')
    } finally {
      store.close()
    }
  })
})


describe('approval hold end to end', () => {
  it('stops the worker after request_approval and resumes only after the owner decides', async () => {
    let workerCalls = 0
    const model = new ScriptedModel(request => {
      if (request.role !== 'worker') return { text: 'owner-facing' }
      workerCalls += 1
      if (workerCalls === 1) {
        return {
          toolCalls: [{
            id: 'approve_1',
            name: 'request_approval',
            args: { action: 'publish the release notes', reason: 'outward-facing' },
          }],
        }
      }
      return { text: 'waiting or resumed' }
    })
    const runtime = freshRuntime({ model, jobDelayMs: 0, watchdogIntervalMs: 60_000 })
    runtimes.push(runtime)
    runtime.ingest(imTrigger({
      id: 'trg_approval',
      thread: 'topic/approval',
      text: '@ds-agent please publish the release notes',
    }))
    await runtime.jobsSettled()

    const [ticket] = runtime.store.listDocs<Ticket>('ticket')
    expect(ticket).toBeDefined()
    const pending = ticket!.collab?.approvals?.find(item => item.status === 'pending')
    expect(pending?.action).toBe('publish the release notes')
    // The Worker got exactly one model call: after the request, its next step
    // was held, so it could not continue to another tool.
    expect(workerCalls).toBe(1)
    expect(ticketStage(ticket!)).toBe('person/approval')

    const decided = await runtime.decideApproval(ticket!.id, pending!.id, 'approved', 'ship it')
    expect(decided.approval.status).toBe('approved')
    expect(workerCalls).toBeGreaterThan(1)
    const guidance = runtime.store.getDoc<Ticket>('ticket', ticket!.id)?.collab?.guidance ?? []
    expect(guidance.some(item => item.text.includes('approved: publish the release notes'))).toBe(true)
  })
})

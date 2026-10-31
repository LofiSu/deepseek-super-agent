import { afterEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import { imTrigger } from '../src/channels/im.ts'
import { Engine } from '../src/core/engine.ts'
import type { Host } from '../src/core/host.ts'
import { Metrics } from '../src/metrics/metrics.ts'
import { LocalEnv } from '../src/env/local-env.ts'
import { runTurn } from '../src/harness/loop.ts'
import type { Model } from '../src/harness/model.ts'
import { SessionJournal } from '../src/harness/session.ts'
import { ToolRegistry } from '../src/harness/tools.ts'
import { workerSessionId } from '../src/harness/session.ts'
import { grantTicketSpill, SPILL_PAGE } from '../src/memory/acl.ts'
import type { Runtime } from '../src/runtime.ts'
import type { Decision, Ticket } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'
import { stuckAssignments } from '../src/watchdog/watchdog.ts'
import { freshRuntime, shutdown, tempHome } from './fixtures.ts'

let runtime: Runtime | undefined
const open: Store[] = []

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
  for (const store of open.splice(0)) {
    if (store.isOpen) store.close()
  }
})

describe('gate and assessment', () => {
  it('ignores a no-action command and does not start a worker', async () => {
    runtime = freshRuntime()
    expect(runtime.ingest(imTrigger({
      id: 'trg_ignore',
      thread: 'topic/notes',
      text: 'please ignore this request, no action needed today',
    }))).toBe('stored')
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(0)
    const decision = runtime.store.listDocs<Decision>('decision').find(item => item.kind === 'ignore')
    expect(decision?.reason).toBe('no-action')
    expect(decision?.triggerIds).toEqual(['trg_ignore'])
    const text = runtime.log.text()
    expect(text).toContain('[engine] Evals.ignore')
    expect(text).not.toContain('Tickets.create')
    expect(text).not.toContain('WorkerSession')
    expect(text).not.toContain('Assignments.start')
  })

  it('records unavailable and does not open a ticket', async () => {
    runtime = freshRuntime()
    expect(runtime.ingest(imTrigger({
      id: 'trg_down',
      thread: 'topic/notes',
      text: 'please assessment unavailable until the model is back',
    }))).toBe('stored')
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(0)
    const decision = runtime.store.listDocs<Decision>('decision')[0]
    expect(decision?.kind).toBe('unavailable')
    expect(decision?.reason).toBe('assessor-unavailable')
    expect(runtime.log.text()).toContain('[engine] Evals.unavailable')
    expect(runtime.log.text()).not.toContain('WorkerSession')
  })

  it('stops the live ticket instead of bypassing or opening another', async () => {
    runtime = freshRuntime()
    expect(runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    const original = runtime.store.listDocs<Ticket>('ticket')[0]!
    expect(runtime.ingest(imTrigger({
      id: 'trg_stop',
      thread: 'topic/bug-login',
      text: '@ds-agent please stop',
    }))).toBe('stored')

    const stopped = runtime.store.getDoc<Ticket>('ticket', original.id)!
    expect(stopped.ended).toMatchObject({ outcome: 'stopped', by: 'human' })
    expect(stopped.assignments.at(-1)?.state).toBe('ended')
    expect(stopped.inputs.some(input => input.triggerId === 'trg_stop')).toBe(false)
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(1)
    const decision = runtime.store.listDocs<Decision>('decision').find(item => item.kind === 'stop')
    expect(decision?.ticketId).toBe(original.id)
    expect(runtime.log.text()).toContain(`[engine] Evals.stop thread=im:topic/bug-login ticketId=${original.id}`)
    expect(runtime.log.text()).not.toContain('bypass=subscription ticketId=')

    const late = runtime.engine.report(original.id, { kind: 'ready', text: 'too late', deliver: true })
    expect(late).toEqual({ surfaced: false, verdict: 'hold' })
    expect(runtime.store.getDoc<Ticket>('ticket', original.id)?.ended).toMatchObject({ outcome: 'stopped', by: 'human' })
    await runtime.jobsSettled()
    expect(runtime.store.getDoc<Ticket>('ticket', original.id)?.ended).toMatchObject({ outcome: 'stopped', by: 'human' })
  })

  it('ignores stop when nothing is live, and still accepts real work', async () => {
    runtime = freshRuntime()
    expect(runtime.ingest(imTrigger({
      id: 'trg_stop',
      thread: 'topic/empty',
      text: 'please stop',
    }))).toBe('stored')
    expect(runtime.store.listDocs<Decision>('decision')[0]).toMatchObject({
      kind: 'ignore',
      reason: 'nothing-to-stop',
    })
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(0)
    expect(runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/empty',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(1)
    expect(runtime.store.listDocs<Decision>('decision').some(item => item.kind === 'accept')).toBe(true)
  })
})

describe('watchdog tick', () => {
  it('nudges a stale assignment and the next tick fails it', () => {
    runtime = freshRuntime({ stuckMs: 1_000 })
    const ticket = runningTicket('ticket_stuck', '2020-01-01T00:00:00.000Z')
    runtime.store.putDoc('ticket', ticket.id, ticket)
    runtime.watchdog.tick()
    expect(runtime.log.text()).toContain('[watchdog] nudge session=worker_ticket_stuck ticketId=ticket_stuck')
    expect(runtime.store.listEvents().some(event => event.type === 'watchdog.nudge')).toBe(true)
    expect(runtime.store.listMessages('worker_ticket_stuck').some(row => row.body.includes('watchdog nudge'))).toBe(true)
    expect(runtime.store.getDoc<Ticket>('ticket', ticket.id)?.ended).toBeUndefined()
    expect(runtime.store.getDoc<Ticket>('ticket', ticket.id)?.assignments[0]?.state).toBe('running')

    runtime.watchdog.tick()
    const failed = runtime.store.getDoc<Ticket>('ticket', ticket.id)!
    expect(failed.ended).toMatchObject({ outcome: 'failed', by: 'watchdog' })
    expect(failed.assignments[0]?.state).toBe('ended')
    expect(runtime.log.text()).toContain('[watchdog] fail ticketId=ticket_stuck')
    expect(runtime.store.listEvents().some(event => event.type === 'watchdog.fail')).toBe(true)
  })

  it('fails an assignment after repeated job failures without waiting for a nudge', () => {
    runtime = freshRuntime({ stuckMs: 60_000 })
    const ticket = runningTicket('ticket_jobs', new Date().toISOString())
    runtime.store.putDoc('ticket', ticket.id, ticket)
    for (const name of ['a', 'b']) {
      const job = runtime.store.createJob({ sessionId: 'worker_ticket_jobs', ticketId: ticket.id, name })
      runtime.store.completeJob(job.id, 'failed')
    }
    runtime.watchdog.tick()
    expect(runtime.store.getDoc<Ticket>('ticket', ticket.id)?.ended).toMatchObject({ outcome: 'failed', by: 'watchdog' })
    expect(runtime.log.text()).toContain('[watchdog] fail ticketId=ticket_jobs')
    expect(runtime.log.text()).not.toContain('[watchdog] nudge')
    expect(stuckAssignments(
      [ticket],
      runtime.store.listJobs(),
      Date.now(),
      60_000,
    ).map(hit => hit.reason)).toEqual(['failed-jobs'])
  })
})

describe('spill ACL', () => {
  it('pages a granted spill and refuses another ticket or session', async () => {
    runtime = freshRuntime()
    runtime.ingest(imTrigger({
      id: 'trg_owner',
      thread: 'topic/owner',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    runtime.ingest(imTrigger({
      id: 'trg_other',
      thread: 'topic/other',
      text: '@ds-agent please fix the payment timeout on checkout',
    }))
    const tickets = runtime.store.listDocs<Ticket>('ticket')
    const owner = tickets.find(ticket => ticket.originTriggerId === 'trg_owner')!
    const other = tickets.find(ticket => ticket.originTriggerId === 'trg_other')!
    const secret = `${'a'.repeat(SPILL_PAGE)}TAILSECRET`
    const spillId = runtime.store.putSpill(secret)
    grantTicketSpill(runtime.store, spillId, owner.id)
    const tools = registry(runtime)

    const first = await tools.invoke(
      { id: 'r1', name: 'read_object', args: { id: spillId } },
      { sessionId: workerSessionId(owner.id), role: 'worker', ticketId: owner.id },
    ) as { text: string; truncated: boolean; nextOffset?: number; total: number }
    expect(first.total).toBe(secret.length)
    expect(first.truncated).toBe(true)
    expect(first.text).toHaveLength(SPILL_PAGE)
    expect(first.text).not.toContain('TAILSECRET')
    expect(JSON.stringify(first)).not.toContain(secret)

    const rest = await tools.invoke(
      { id: 'r2', name: 'read_object', args: { id: spillId, offset: first.nextOffset } },
      { sessionId: workerSessionId(owner.id), role: 'worker' },
    ) as { text: string; truncated: boolean }
    expect(rest.text).toBe('TAILSECRET')
    expect(rest.truncated).toBe(false)

    await expect(tools.invoke(
      { id: 'r3', name: 'read_object', args: { id: spillId } },
      { sessionId: workerSessionId(other.id), role: 'worker', ticketId: other.id },
    )).rejects.toThrow(/not visible/)
    await expect(tools.invoke(
      { id: 'r4', name: 'read_object', args: { id: spillId } },
      { sessionId: 'worker_stranger', role: 'worker' },
    )).rejects.toThrow(/not visible/)
    await expect(tools.invoke(
      { id: 'r5', name: 'read_object', args: { id: 'spill_missing' } },
      { sessionId: workerSessionId(owner.id), role: 'worker', ticketId: owner.id },
    )).rejects.toThrow(/unknown spill/)
  })
})

describe('journal-driven turns', () => {
  it('builds the next model call from the session journal', async () => {
    const home = tempHome()
    const store = new Store(home)
    open.push(store)
    const lines: string[] = []
    const engine = new Engine(hostFor(store, lines))
    const tools = new ToolRegistry({
      store,
      engine,
      env: new LocalEnv(path.join(home, 'workspaces')),
      metrics: new Metrics(home),
      redact: text => text,
      log: line => lines.push(line),
      scheduleJob: () => {},
      routerTurn: async () => {},
    })
    const journal = new SessionJournal(path.join(home, 'sessions'), store, () => {})
    const seen: string[][] = []
    let step = 0
    const model: Model = {
      name: 'recorder',
      classify: () => ({ pass: true, strength: 'explicit', reason: 'explicit' }),
      async complete(request) {
        seen.push(request.messages.map(message => message.content))
        step += 1
        if (step === 1) {
          return { toolCalls: [{ id: 'call_bash_0', name: 'bash', args: { command: 'echo worker-ok' } }] }
        }
        return { text: 'done' }
      },
    }
    const session = { id: 'worker_ticket_1', role: 'worker' as const, ticketId: 'ticket_1' }
    const turn = {
      model,
      tools,
      journal,
      log: () => {},
      metrics: new Metrics(home),
      redact: (text: string) => text,
      session,
    }
    await runTurn({ ...turn, prompt: 'TASK\nticketId=ticket_1' })
    await runTurn({ ...turn, prompt: 'JOB_DONE\njobId=job_1\nticketId=ticket_1' })
    const jobCall = seen.find(messages => messages.some(content => content.startsWith('JOB_DONE')))
    expect(jobCall).toBeTruthy()
    const blob = jobCall!.join('\n')
    expect(blob).toContain('worker-ok')
    expect(blob).toContain('TASK')
    expect(blob).toContain('JOB_DONE')
    const jobAt = jobCall!.findIndex(content => content.startsWith('JOB_DONE'))
    expect(jobAt).toBeGreaterThan(1)
    expect(jobCall![0]).toContain('WorkerSession')
  })
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

function registry(runtime: Runtime): ToolRegistry {
  return new ToolRegistry({
    store: runtime.store,
    engine: runtime.engine,
    env: new LocalEnv(path.join(runtime.home, 'workspaces')),
    metrics: runtime.metrics,
    redact: text => text,
    log: () => {},
    scheduleJob: () => {},
    routerTurn: async () => {},
  })
}

function runningTicket(id: string, startedAt: string): Ticket {
  return {
    id,
    title: id,
    brief: 'fix the login timeout',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-v1',
      scope: 'fix the login timeout',
      actor: { source: 'im', id: 'alex' },
      basis: 'addressed',
    },
    threadKeys: ['im:topic/bug-login'],
    channels: [],
    inputs: [],
    assignments: [{
      id: `${id}_asg`,
      state: 'running',
      speculative: false,
      workerSessionId: `worker_${id}`,
      startedAt,
    }],
    speculative: false,
    originTriggerId: `trg_${id}`,
    createdAt: startedAt,
  }
}

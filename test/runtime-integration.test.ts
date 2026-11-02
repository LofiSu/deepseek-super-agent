import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import type { Runtime } from '../src/runtime.ts'
import type { Disposition, Ticket } from '../src/shared/types.ts'
import { freshRuntime, shutdown } from './fixtures.ts'
import { field, lastPrompt, ScriptedModel, silentModel } from './scripted-model.ts'

const runtimes: Runtime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await shutdown(runtime)
})

function isolatedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  delete env.DS_AGENT_ALLOW_MOCK_FIXTURE
  delete env.DS_AGENT_ROUTER_MODEL
  delete env.DS_AGENT_WORKER_MODEL
  delete env.DS_AGENT_WATCHDOG_MODEL
  return env
}

function start(opts: { model?: ScriptedModel; env?: NodeJS.ProcessEnv; singleSession?: boolean } = {}): Runtime {
  const runtime = freshRuntime({
    model: opts.model ?? silentModel(),
    env: opts.env ?? isolatedEnv(),
    singleSession: opts.singleSession,
    jobDelayMs: 5,
    watchdogIntervalMs: 60_000,
  })
  runtimes.push(runtime)
  return runtime
}

/** Reports one ready result, which ends a non-speculative ticket. */
function reportingModel(prompts: string[] = []): ScriptedModel {
  return new ScriptedModel(request => {
    if (request.role === 'router') return { text: 'router-ok' }
    const prompt = lastPrompt(request)
    if (request.role === 'worker') prompts.push(prompt)
    const reported = request.messages.some(message => message.role === 'tool' && message.name === 'report_to_router')
    if (!reported) {
      return {
        toolCalls: [{
          id: 'report_1',
          name: 'report_to_router',
          args: {
            ticketId: field(prompt, 'ticketId'),
            text: 'ready: login timeout fixed by refreshing the token',
            deliver: true,
            kind: 'ready',
          },
        }],
      }
    }
    return { text: 'worker-done' }
  })
}

describe('Runtime service integration', () => {
  it('routes a trigger to a shard, runs that router session, and places the worker on the mesh', async () => {
    const runtime = start({
      env: isolatedEnv({
        DS_AGENT_INSTANCE_ID: 'alpha',
        DS_AGENT_SHARDS: JSON.stringify([{ id: 'im', filter: 'source:im', priority: 10 }]),
      }),
    })
    expect(runtime.log.text()).toContain('[routing] shards configured count=1')
    runtime.ingest(imTrigger({
      id: 'trg_shard',
      thread: 'topic/shard',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    await runtime.jobsSettled()

    const disposition = runtime.store.getDoc<Disposition>('disposition', 'trg_shard')
    expect(disposition?.shards).toEqual(['im'])
    expect(runtime.log.text()).toContain('[routing] shards=im')
    expect(runtime.log.text()).toContain('MainSession start session=router:im')
    expect(runtime.log.text()).toContain('[mesh] place')

    const [ticket] = runtime.store.listDocs<Ticket>('ticket')
    expect(ticket?.assignments[0]?.node).toBe('alpha')
    expect(runtime.store.listEvents().some(event => event.type === 'assignment.placed')).toBe(true)
  })

  it('ignores malformed shard config instead of failing startup', () => {
    const runtime = start({ env: isolatedEnv({ DS_AGENT_SHARDS: 'not-json' }) })
    expect(runtime.log.text()).toContain('DS_AGENT_SHARDS ignored')
    expect(runtime.routerShards.route(imTrigger({
      id: 'trg_cfg',
      thread: 'topic/cfg',
      text: '@ds-agent please fix the login timeout',
    }))).toEqual(['default'])
  })

  it('writes a long-term memory on ticket end and recalls it on the next ticket', async () => {
    const prompts: string[] = []
    const runtime = start({ model: reportingModel(prompts) })

    runtime.ingest(imTrigger({
      id: 'trg_mem_1',
      thread: 'topic/mem-1',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    await runtime.jobsSettled()
    const first = runtime.store.listDocs<Ticket>('ticket')[0]
    expect(first?.ended).toBeDefined()
    const memory = runtime.store.getDoc<{ id: string }>('ltm', `ltm_${first!.id}`)
    expect(memory).toBeDefined()

    runtime.ingest(imTrigger({
      id: 'trg_mem_2',
      thread: 'topic/mem-2',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    await runtime.jobsSettled()

    const secondPrompt = prompts.at(-1) ?? ''
    expect(secondPrompt).toContain(`memory=ltm_${first!.id}`)
    expect(secondPrompt).toContain('login timeout')
    expect(runtime.metrics.snapshot().counters['memory.remembered']).toBeGreaterThanOrEqual(2)
    expect(runtime.metrics.snapshot().counters['memory.recalled']).toBeGreaterThanOrEqual(1)
  })

  it('publishes ticket lifecycle events to the lifecycle bus', async () => {
    const runtime = start({ model: reportingModel() })
    const created: unknown[] = []
    const ended: unknown[] = []
    runtime.lifecycle.subscribe('ticket.created', event => created.push(event))
    runtime.lifecycle.subscribe('ticket.ended', event => ended.push(event))

    runtime.ingest(imTrigger({
      id: 'trg_shell',
      thread: 'topic/shell',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    await runtime.jobsSettled()

    expect(created).toHaveLength(1)
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ kind: 'ticket.ended', payload: { outcome: 'ready' } })
  })

  it('turns a local A2A envelope into a normal filtered trigger', async () => {
    const runtime = start({ env: isolatedEnv({ DS_AGENT_INSTANCE_ID: 'alpha' }) })
    const delivery = runtime.sendA2A('alpha', {
      text: '@ds-agent please fix the login timeout on checkout',
      thread: 'a2a/thread-1',
    })
    expect(delivery.status).toBe('delivered')
    expect(delivery.delivered).toBe(1)
    await runtime.jobsSettled()

    expect(runtime.log.text()).toContain('[a2a] received')
    const ticket = runtime.store.listDocs<Ticket>('ticket')[0]
    expect(ticket?.threadKeys).toEqual(['a2a:a2a/thread-1'])
    expect(runtime.a2aRouter.list()).toHaveLength(1)

    const unroutable = runtime.sendA2A('beta', { text: 'no listener' })
    expect(unroutable.status).toBe('unroutable')
    expect(unroutable.persisted).toBe(true)
    expect(runtime.a2aRouter.list()).toHaveLength(2)
  })

  it('publishes pause and guidance as lifecycle events', async () => {
    const runtime = start()
    runtime.ingest(imTrigger({
      id: 'trg_shell_live',
      thread: 'topic/shell-live',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    await runtime.jobsSettled()
    const ticket = runtime.store.listDocs<Ticket>('ticket')[0]!
    const events: unknown[] = []
    runtime.lifecycle.subscribe('ticket.paused', event => events.push(event))
    runtime.lifecycle.subscribe('ticket.guidance', event => events.push(event))

    runtime.pause(ticket.id, { reason: 'waiting on staging' })
    runtime.intervene(ticket.id, 'use the staging database')

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ kind: 'ticket.paused', payload: { ticketId: ticket.id } })
    expect(events[1]).toMatchObject({ kind: 'ticket.guidance', payload: { ticketId: ticket.id } })
    expect(runtime.lifecycle.snapshot(1)).toHaveLength(1)
  })

  it('rejects a malformed A2A envelope', () => {
    const runtime = start()
    expect(() => runtime.sendA2A('', { text: 'x' })).toThrow(/to address/)
    expect(() => runtime.sendA2A('alpha', { text: 'x'.repeat(70_000) })).toThrow(/exceeds/)
  })

  it('makes the single-session bake-off baseline observable in metrics', async () => {
    const dual = start()
    dual.ingest(imTrigger({
      id: 'trg_dual',
      thread: 'topic/dual',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    await dual.jobsSettled()

    const single = start({ singleSession: true })
    single.ingest(imTrigger({
      id: 'trg_single',
      thread: 'topic/single',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    await single.jobsSettled()

    const dualCalls = dual.metrics.snapshot().counters['model.call']
    const singleCalls = single.metrics.snapshot().counters['model.call']
    expect(singleCalls).toBe(1)
    expect(dualCalls).toBeGreaterThan(singleCalls)
    expect(single.log.text()).toContain('[harness] single-session')
    expect(single.log.text()).not.toContain('MainSession start')
  })
})

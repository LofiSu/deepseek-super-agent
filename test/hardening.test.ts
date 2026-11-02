import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { LocalEnv, type LocalEnvOptions } from '../src/env/local-env.ts'
import { HttpOpenAI } from '../src/harness/model.ts'
import { readSpillFor } from '../src/memory/acl.ts'
import { Runtime, type RuntimeOptions } from '../src/runtime.ts'
import type { Disposition, Ticket } from '../src/shared/types.ts'
import { driftAssignments, stuckAssignments } from '../src/watchdog/watchdog.ts'
import { loadWatchdogRules } from '../src/watchdog/rules.ts'
import { field, lastPrompt, ScriptedModel, silentModel } from './scripted-model.ts'

const runtimes: Runtime[] = []

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.daemon.stop()
    if (runtime.store.isOpen) runtime.store.close()
  }
})

function makeRuntime(opts: Partial<RuntimeOptions> = {}): Runtime {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-hardening-'))
  const runtime = Runtime.create({
    home,
    model: silentModel(),
    watchdogIntervalMs: 60_000,
    stuckMs: 60_000,
    ...opts,
  })
  runtimes.push(runtime)
  return runtime
}

function tickets(runtime: Runtime): Ticket[] {
  return runtime.store.listDocs<Ticket>('ticket')
}

describe('trigger.meta is data, not a decision (C1)', () => {
  it('does not admit a trigger the filter dropped', () => {
    const runtime = makeRuntime()
    const noise = imTrigger({
      id: 'trg_noise',
      thread: 'topic/noise',
      text: 'lol nice weather today haha',
      addressed: false,
    })
    const result = runtime.ingest({ ...noise, meta: { ...noise.meta, admitted: true } })
    expect(result).toBe('filtered')
    expect(tickets(runtime)).toHaveLength(0)
  })

  it('does not grant a caller-supplied spill id to a new ticket', () => {
    const runtime = makeRuntime()
    const spillId = runtime.store.putSpill('another ticket secret')
    const trigger = imTrigger({
      id: 'trg_short',
      thread: 'topic/spill',
      text: '@ds-agent please fix it',
    })
    const result = runtime.ingest({ ...trigger, meta: { spillId } })
    expect(result).toBe('stored')
    const ticket = tickets(runtime)[0]
    expect(ticket?.spillId).toBeUndefined()
    expect(() => readSpillFor(runtime.store, spillId, { ticketId: ticket!.id }))
      .toThrow(/not visible/)
  })
})

describe('credential values never reach a spill body (H1)', () => {
  it('redacts the persisted spill, not only the journal', () => {
    const runtime = makeRuntime({
      env: { ...process.env, DS_AGENT_API_KEY: 'SENTINEL-HARDENING-VALUE' },
    })
    const text = `@ds-agent please investigate SENTINEL-HARDENING-VALUE ${'log line '.repeat(40)}`
    runtime.ingest(imTrigger({ id: 'trg_redact', thread: 'topic/redact', text }))
    const spillId = /spillId=(spill_\d+)/.exec(runtime.log.text())?.[1]
    expect(spillId).toBeTruthy()
    const body = runtime.store.getSpill(spillId!) ?? ''
    expect(body).not.toContain('SENTINEL-HARDENING-VALUE')
    expect(body).toContain('[redacted]')
  })
})

describe('LocalEnv process boundary (H2/H3)', () => {
  function envFor(options: LocalEnvOptions): LocalEnv {
    return new LocalEnv(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-env-')), {
      sandbox: { enabled: false },
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      ...options,
    })
  }

  it('kills the process group on timeout instead of waiting for a grandchild', async () => {
    const env = envFor({ timeoutMs: 300 })
    const started = Date.now()
    const result = await env.bash('w1', 'sleep 5; echo done')
    expect(Date.now() - started).toBeLessThan(2_500)
    expect(result.code).toBe(124)
    expect(result.stderr).toContain('[timeout]')
    expect(result.stdout).not.toContain('done')
  })

  it('caps runaway stdout', async () => {
    const env = envFor({ maxOutputBytes: 200 })
    const result = await env.bash('w2', 'yes x | head -c 20000')
    expect(result.stdout.length).toBeLessThan(400)
    expect(result.stdout).toContain('[truncated]')
  })

  it('refuses a quoted absolute path from a speculative shell', async () => {
    const env = envFor({})
    const target = path.join(os.tmpdir(), `ds-agent-escape-${process.pid}`)
    await expect(env.bash(
      'w3',
      `python3 -c "open('${target}','w').write('x')"`,
      { isolated: true },
    )).rejects.toThrow(/isolated workdir/)
    expect(fs.existsSync(target)).toBe(false)
  })
})

describe('control plane (M1/M2/H4/M6/M8)', () => {
  it('uses per-role models when configured', () => {
    const runtime = makeRuntime({
      models: { router: silentModel('router'), worker: silentModel('worker') },
    })
    expect(runtime.log.text()).toContain('role models')
    expect(runtime.log.text()).toContain('router=ScriptedModel')
    expect(runtime.log.text()).toContain('worker=ScriptedModel')
  })

  it('folds same-thread triggers inside the batch window into one Eval', () => {
    const runtime = makeRuntime({ batchWindowMs: 25 })
    runtime.ingest(imTrigger({ id: 'trg_b1', thread: 'topic/batch', text: '@ds-agent please fix login' }))
    runtime.ingest(imTrigger({ id: 'trg_b2', thread: 'topic/batch', text: '@ds-agent please fix signup' }))
    expect(tickets(runtime)).toHaveLength(0)
    runtime.flushEvals()
    expect(runtime.log.text()).toMatch(/Evals\.batch thread=im:topic\/batch size=2/)
    expect(tickets(runtime)).toHaveLength(1)
  })

  it('lets the Router veto an accepted ticket before the Worker starts', async () => {
    const model = new ScriptedModel(request => {
      if (request.role !== 'router') return { text: 'worker-should-not-run' }
      const used = request.messages.some(message => message.role === 'tool' && message.name === 'assess_trigger')
      if (used) return { text: 'vetoed' }
      const prompt = lastPrompt(request)
      return {
        toolCalls: [{
          id: 'veto_1',
          name: 'assess_trigger',
          args: {
            triggerId: field(prompt, 'triggerId'),
            ticketId: field(prompt, 'ticketId'),
            kind: 'stop',
            reason: 'test-veto',
          },
        }],
      }
    })
    const runtime = makeRuntime({ model })
    runtime.ingest(imTrigger({
      id: 'trg_veto',
      thread: 'topic/veto',
      text: '@ds-agent please fix the checkout timeout',
    }))
    await runtime.drain()
    expect(runtime.log.text()).toContain('worker skipped')
    expect(runtime.log.text()).not.toContain('WorkerSession start')
    expect(tickets(runtime)[0]?.ended?.outcome).toBe('stopped')
  })

  it('lets the Router stop a ticket through the engine', () => {
    const runtime = makeRuntime()
    runtime.ingest(imTrigger({ id: 'trg_stop', thread: 'topic/stop', text: '@ds-agent please fix checkout' }))
    runtime.flushEvals()
    const ticket = tickets(runtime)[0]!
    runtime.engine.stop(ticket.id, 'test-stop')
    const ended = runtime.store.getDoc<Ticket>('ticket', ticket.id)!
    expect(ended.ended).toMatchObject({ outcome: 'stopped', by: 'router' })
    expect(ended.assignments.at(-1)?.state).toBe('ended')
  })

  it('does not bypass Eval for a contextOnly subscription', async () => {
    const runtime = makeRuntime()
    runtime.ingest(imTrigger({ id: 'trg_c1', thread: 'topic/ctx', text: '@ds-agent please fix checkout' }))
    runtime.flushEvals()
    await runtime.drain()
    const ticket = tickets(runtime)[0]!
    runtime.engine.subscribe(ticket.id, 'im:topic/ctx', { contextOnly: true })
    const result = runtime.ingest(imTrigger({
      id: 'trg_c2',
      thread: 'topic/ctx',
      text: '@ds-agent any update on the checkout?',
    }))
    expect(result).toBe('stored')
    expect(runtime.store.getDoc<Disposition>('disposition', 'trg_c2')?.fanout).toEqual([])
  })

  it('treats a progress report as a heartbeat, not an exemption', () => {
    const now = Date.parse('2026-11-01T01:00:00.000Z')
    const base = {
      id: 't1',
      ended: undefined,
      collab: undefined,
      assignments: [{
        id: 'a1',
        state: 'running' as const,
        speculative: false,
        workerSessionId: 'worker_t1',
        startedAt: '2026-11-01T00:00:00.000Z',
      }],
    }
    const staleReport = {
      ...base,
      assignments: [{
        ...base.assignments[0],
        report: { kind: 'progress', text: 'still working', at: '2026-11-01T00:10:00.000Z' },
      }],
    } as unknown as Ticket
    expect(stuckAssignments([staleReport], [], now, 20 * 60_000)).toHaveLength(1)
    const freshReport = {
      ...base,
      assignments: [{
        ...base.assignments[0],
        report: { kind: 'progress', text: 'still working', at: '2026-11-01T00:55:00.000Z' },
      }],
    } as unknown as Ticket
    expect(stuckAssignments([freshReport], [], now, 20 * 60_000)).toHaveLength(0)
  })

  it('nudges a running report that says it left the ticket scope', () => {
    const rules = loadWatchdogRules()
    const base = {
      id: 't1',
      ended: undefined,
      collab: undefined,
      assignments: [{
        id: 'a1',
        state: 'running' as const,
        speculative: false,
        workerSessionId: 'worker_t1',
      }],
    }
    const drifting = {
      ...base,
      assignments: [{
        ...base.assignments[0],
        report: { kind: 'progress', text: 'This work is out of scope for the ticket', at: '2026-11-01T00:10:00.000Z' },
      }],
    } as unknown as Ticket
    expect(driftAssignments([drifting], rules)).toEqual([{
      ticketId: 't1',
      assignmentId: 'a1',
      sessionId: 'worker_t1',
      reason: 'goal-drift',
    }])
    const normal = {
      ...base,
      assignments: [{
        ...base.assignments[0],
        report: { kind: 'progress', text: 'still working on the login timeout', at: '2026-11-01T00:10:00.000Z' },
      }],
    } as unknown as Ticket
    expect(driftAssignments([normal], rules)).toHaveLength(0)
  })

  it('runs an async job to completion without a live model', async () => {
    const model = new ScriptedModel(request => {
      if (request.role !== 'worker') return { text: 'router-ok' }
      const started = request.messages.some(message => message.role === 'tool' && message.name === 'start_job')
      if (!started) return { toolCalls: [{ id: 'job_1', name: 'start_job', args: { name: 'probe' } }] }
      return { text: 'worker-done' }
    })
    const runtime = makeRuntime({ model, jobDelayMs: 10 })
    runtime.ingest(imTrigger({
      id: 'trg_job',
      thread: 'topic/job',
      text: '@ds-agent please investigate the job path',
    }))
    await runtime.jobsSettled()
    const jobs = runtime.store.listJobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.status).toBe('succeeded')
    expect(runtime.log.text()).toContain('async job started')
    expect(runtime.log.text()).toContain('async job finished')
  })

  it('does not run the result turn for a stopped job (M8)', async () => {
    const runtime = makeRuntime({ jobDelayMs: 10 })
    const job = runtime.store.createJob({ sessionId: 'worker_t1', ticketId: 't1', name: 'probe' })
    runtime.store.completeJob(job.id, 'stopped')
    runtime.harness.scheduleJob({ id: job.id, sessionId: 'worker_t1', ticketId: 't1' })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(runtime.log.text()).toContain('async job skipped')
    expect(runtime.store.getJob(job.id)?.status).toBe('stopped')
  })

  it('does not start a completion turn after the ticket ended (T43 rollback)', async () => {
    const runtime = makeRuntime({ jobDelayMs: 20 })
    runtime.store.putDoc('ticket', 't1', {
      id: 't1',
      ended: { at: '2026-11-02T00:00:00.000Z', outcome: 'discarded', by: 'executor' },
      assignments: [],
    })
    const job = runtime.store.createJob({ sessionId: 'worker_t1', ticketId: 't1', name: 'probe' })
    runtime.harness.scheduleJob({ id: job.id, sessionId: 'worker_t1', ticketId: 't1' })
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(runtime.log.text()).toContain('async job skipped')
    expect(runtime.log.text()).toContain('ticket=ended')
    expect(runtime.store.getJob(job.id)?.status).toBe('stopped')
  })
})

describe('subscription removal (M5/T21)', () => {
  it('unsubscribes without requeueing the trigger', () => {
    const runtime = makeRuntime()
    runtime.ingest(imTrigger({
      id: 'trg_unsub',
      thread: 'topic/unsub',
      text: '@ds-agent please fix the login timeout',
    }))
    const ticket = tickets(runtime)[0]!
    const threadKey = ticket.threadKeys[0]!
    expect(runtime.store.getDoc<{ subscriptions: string[] }>('thread', threadKey)?.subscriptions)
      .toContain(ticket.id)

    expect(runtime.engine.unsubscribe(ticket.id, threadKey, 'test')).toBe(true)
    const thread = runtime.store.getDoc<{ subscriptions: string[]; pending: string[] }>('thread', threadKey)
    expect(thread?.subscriptions).not.toContain(ticket.id)
    expect(thread?.pending).not.toContain('trg_unsub')
    expect(runtime.store.getDoc<Ticket>('ticket', ticket.id)?.threadKeys).not.toContain(threadKey)
    expect(runtime.store.listEvents().some(event => event.type === 'subscription.removed')).toBe(true)
    expect(runtime.engine.unsubscribe(ticket.id, threadKey, 'again')).toBe(false)
  })
})

describe('HttpOpenAI failure handling (M7)', () => {
  it('does not reject a turn on malformed tool arguments', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: 'bad_1', function: { name: 'bash', arguments: '{not-json' } }],
          },
        }],
      }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      const model = new HttpOpenAI(`http://127.0.0.1:${port}/v1`, 'test-key', 'test-model', 2_000)
      const out = await model.complete({
        role: 'worker',
        messages: [{ role: 'user', content: 'probe' }],
        tools: [],
      })
      expect(out.toolCalls).toEqual([])
      expect(out.text).toContain('malformed')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('bounds an unanswered request with a timeout', async () => {
    const server = createServer(() => {
      // Never respond.
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      const model = new HttpOpenAI(`http://127.0.0.1:${port}/v1`, 'test-key', 'test-model', 100)
      await expect(model.complete({
        role: 'worker',
        messages: [{ role: 'user', content: 'probe' }],
        tools: [],
      })).rejects.toThrow()
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

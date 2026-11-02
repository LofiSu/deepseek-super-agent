import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import type { Runtime } from '../src/runtime.ts'
import { freshRuntime, settleWithDeadline, shutdown } from './fixtures.ts'
import { ScriptedModel } from './scripted-model.ts'
import { stuckSessions } from '../src/watchdog/watchdog.ts'

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

describe('async job', () => {
  it('returns started immediately and later marks the job succeeded', async () => {
    // Deterministic protocol: assert the job machinery, not a live model's tool choice.
    const model = new ScriptedModel(request => {
      if (request.role !== 'worker') return { text: 'router-ok' }
      const started = request.messages.some(message => message.role === 'tool' && message.name === 'start_job')
      if (!started) return { toolCalls: [{ id: 'job_1', name: 'start_job', args: { name: 'probe' } }] }
      return { text: 'worker-done' }
    })
    runtime = freshRuntime({ model })
    runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    await settleWithDeadline(runtime, 90_000)
    const jobs = runtime.store.listJobs()
    expect(jobs.length).toBeGreaterThan(0)
    expect(jobs.every(job => job.status === 'succeeded')).toBe(true)
    const text = runtime.log.text()
    expect(text).toContain('async job started')
    expect(text).toContain('status=started')
    expect(text).toContain('status=succeeded')
    const bodies = runtime.store.listMessages().map(message => message.body).join('\n')
    expect(bodies).toContain('start_job')
    expect(bodies).toContain('job_1')
    expect(bodies).toContain('started')
  })

  it('does not throw if the store closes before the worker turn runs', async () => {
    runtime = freshRuntime()
    runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    runtime.daemon.stop()
    runtime.store.close()
    await runtime.drain()
  })
})

describe('watchdog', () => {
  it('flags a worker with no recent heartbeat', () => {
    const now = Date.parse('2026-10-31T00:00:00.000Z')
    const stuck = stuckSessions([
      {
        id: 'worker_ticket_1',
        role: 'worker',
        ticketId: 'ticket_1',
        status: 'running',
        heartbeat: '2026-10-30T00:00:00.000Z',
        createdAt: '2026-10-30T00:00:00.000Z',
      },
      {
        id: 'router',
        role: 'router',
        status: 'running',
        heartbeat: '2020-01-01T00:00:00.000Z',
        createdAt: '2020-01-01T00:00:00.000Z',
      },
    ], now, 60_000)
    expect(stuck.map(session => session.id)).toEqual(['worker_ticket_1'])
  })
})

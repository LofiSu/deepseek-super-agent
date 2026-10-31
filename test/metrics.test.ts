import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { githubTrigger } from '../src/channels/github.ts'
import { imTrigger } from '../src/channels/im.ts'
import { emptySnapshot, readMetrics } from '../src/metrics/metrics.ts'
import type { Runtime } from '../src/runtime.ts'
import type { Ticket } from '../src/shared/types.ts'
import { freshRuntime, shutdown } from './fixtures.ts'

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

describe('section 7 metrics', () => {
  it('returns zeros when the state dir has no metrics file', () => {
    expect(readMetrics(path.join('/tmp', 'ds-agent-metrics-missing'))).toEqual(emptySnapshot())
  })

  it('counts ingress, eval, bypass, speculate, watchdog, and model latency', async () => {
    runtime = freshRuntime()
    expect(runtime.ingest(imTrigger({
      id: 'trg_noise',
      thread: 'topic/chatter',
      text: 'lol nice weather today haha',
      addressed: false,
    }))).toBe('filtered')
    expect(runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    expect(runtime.ingest(imTrigger({
      id: 'trg_login_2',
      thread: 'topic/bug-login',
      text: '@ds-agent login still 500, the timeout is back',
    }))).toBe('stored')
    expect(runtime.ingest(githubTrigger({
      id: 'trg_maybe',
      pr: 99,
      text: 'might be a flaky payment test, not sure it is ours',
      speculate: true,
    }))).toBe('stored')
    expect(runtime.ingest(imTrigger({
      id: 'trg_noise',
      thread: 'topic/chatter',
      text: 'lol nice weather today haha',
      addressed: false,
    }))).toBe('duplicate')
    await runtime.jobsSettled()

    runtime.store.upsertSession({
      id: 'worker_stuck_probe',
      role: 'worker',
      ticketId: 'ticket_probe',
      status: 'running',
      heartbeat: '2020-01-01T00:00:00.000Z',
      createdAt: '2020-01-01T00:00:00.000Z',
    })
    runtime.watchdog.tick()
    const ticket = runtime.store.listDocs<Ticket>('ticket').find(item => !item.speculative)
    expect(ticket).toBeTruthy()
    runtime.engine.report(ticket!.id, { kind: 'failed', text: 'watchdog: stuck', deliver: false })
    const donor = runtime.store.listDocs<Ticket>('ticket')[0]!
    runtime.store.putDoc('ticket', 'ticket_discard_probe', {
      ...donor,
      id: 'ticket_discard_probe',
      speculative: true,
      ended: undefined,
      assignments: [{ id: 'asg_probe', state: 'running', speculative: true }],
    })
    runtime.engine.report('ticket_discard_probe', { kind: 'dropped', text: 'not valuable', deliver: false })

    const snap = runtime.metrics.snapshot()
    expect(snap.counters).toEqual({
      'ingress.admit': 3,
      'ingress.drop': 1,
      'eval.accept': 2,
      'bypass.fanout': 1,
      'speculate.deliver': 1,
      'speculate.discard': 1,
      'watchdog.nudge': 1,
      'watchdog.fail': 1,
    })
    expect(snap.modelLatencyMs.count).toBeGreaterThan(0)
    expect(snap.modelLatencyMs.sum).toBeGreaterThanOrEqual(0)
    expect(snap.modelLatencyMs.max).toBeGreaterThanOrEqual(snap.modelLatencyMs.last)
    expect(readMetrics(runtime.home)).toEqual(snap)

    const cli = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'metrics'], {
      cwd: path.resolve('.'),
      env: { ...process.env, DS_AGENT_HOME: runtime.home },
      encoding: 'utf8',
    })
    expect(cli.status, cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout)).toEqual(snap)
  })
})

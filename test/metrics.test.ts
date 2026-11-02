import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { githubTrigger } from '../src/channels/github.ts'
import { imTrigger } from '../src/channels/im.ts'
import { emptySnapshot, Metrics, metricsPath, readMetrics } from '../src/metrics/metrics.ts'
import type { Runtime } from '../src/runtime.ts'
import type { Ticket } from '../src/shared/types.ts'
import { freshRuntime, settleWithDeadline, shutdown, tempHome } from './fixtures.ts'

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

describe('section 7 metrics', () => {
  it('returns zeros when the state dir has no metrics file', () => {
    expect(readMetrics(path.join('/tmp', 'ds-agent-metrics-missing'))).toEqual(emptySnapshot())
  })

  it('coalesces hot-path writes, writes atomically, and merges another process', () => {
    const home = tempHome()
    const first = new Metrics(home)
    const second = new Metrics(home)
    first.increment('ingress.admit')
    first.increment('ingress.admit')
    expect(fs.existsSync(metricsPath(home))).toBe(false)
    first.flush()
    expect(fs.readdirSync(home).some(name => name.endsWith('.tmp'))).toBe(false)
    expect(readMetrics(home).counters['ingress.admit']).toBe(2)

    second.increment('ingress.drop')
    second.flush()
    first.flush()
    const merged = readMetrics(home)
    expect(merged.counters['ingress.admit']).toBe(2)
    expect(merged.counters['ingress.drop']).toBe(1)
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
    await settleWithDeadline(runtime, 90_000)

    runtime.store.upsertSession({
      id: 'worker_stuck_probe',
      role: 'worker',
      ticketId: 'ticket_probe',
      status: 'running',
      heartbeat: '2020-01-01T00:00:00.000Z',
      createdAt: '2020-01-01T00:00:00.000Z',
    })
    runtime.watchdog.tick()
    const donor = runtime.store.listDocs<Ticket>('ticket')[0]!
    expect(donor).toBeTruthy()
    // A worker self-report must not count as a watchdog failure; only the
    // watchdog surface does.
    runtime.store.putDoc('ticket', 'ticket_worker_failed_probe', {
      ...donor,
      id: 'ticket_worker_failed_probe',
      speculative: false,
      ended: undefined,
      assignments: [{ id: 'asg_worker_probe', state: 'running', speculative: false }],
    })
    runtime.engine.report('ticket_worker_failed_probe', { kind: 'failed', text: 'worker gave up', deliver: false })
    runtime.store.putDoc('ticket', 'ticket_watchdog_probe', {
      ...donor,
      id: 'ticket_watchdog_probe',
      speculative: false,
      ended: undefined,
      assignments: [{ id: 'asg_watchdog_probe', state: 'running', speculative: false }],
    })
    runtime.engine.watchdogFail('ticket_watchdog_probe', 'watchdog: stuck')
    runtime.store.putDoc('ticket', 'ticket_discard_probe', {
      ...donor,
      id: 'ticket_discard_probe',
      speculative: true,
      ended: undefined,
      assignments: [{ id: 'asg_probe', state: 'running', speculative: true }],
    })
    runtime.engine.report('ticket_discard_probe', { kind: 'dropped', text: 'not valuable', deliver: false })

    runtime.metrics.flush()
    const snap = runtime.metrics.snapshot()
    // Deterministic counters: ingress, eval, and the two reports forced above.
    expect(snap.counters).toMatchObject({
      'ingress.admit': 3,
      'ingress.drop': 1,
      'eval.accept': 2,
      'bypass.fanout': 1,
      'bypass.context': 0,
      'executor.fail': 1,
      'speculate.deliver': 1,
      'speculate.discard': 1,
      'watchdog.idle': 1,
      'watchdog.nudge': 1,
      // Only the explicit watchdog probe counts here; the worker failure above
      // is recorded as executor.fail instead.
      'watchdog.fail': 1,
      'model.error': 0,
    })
    // These depend on what the live model chose to do in this run.
    expect(snap.counters).toHaveProperty('speculate.deliver')
    expect(snap.counters).toHaveProperty('watchdog.idle')
    expect(snap.counters['watchdog.nudge']).toBeGreaterThanOrEqual(1)
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

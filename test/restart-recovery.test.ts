import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SemanticHit } from '../src/ingress/filter.ts'
import { MockModel, type Completion, type Model } from '../src/harness/model.ts'
import { Runtime, type RuntimeOptions } from '../src/runtime.ts'
import type { Ticket } from '../src/shared/types.ts'
import { shutdown, tempHome } from './fixtures.ts'

/**
 * Stands in for a configured provider without making network calls. Recovery
 * only distinguishes MockModel by name, so this exercises the live-model path
 * while keeping the suite offline.
 */
class StubLiveModel implements Model {
  readonly name = 'StubLiveModel'

  classify(): SemanticHit {
    return { pass: true, strength: 'explicit', reason: 'stub' }
  }

  async complete(): Promise<Completion> {
    return { text: 'stub' }
  }
}

const SECRET = 'sk-restart-recovery-sentinel-value'

const runtimes: Runtime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    if (runtime.store.isOpen) await shutdown(runtime)
  }
  vi.restoreAllMocks()
})

function runningTicket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  const at = new Date().toISOString()
  return {
    id,
    title: 'Investigate the full disk',
    brief: 'Find why the build host disk filled up.',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-v1',
      scope: 'investigate the disk usage',
      actor: { source: 'im', id: 'alex' },
      basis: 'addressed',
    },
    threadKeys: ['im:topic/disk'],
    channels: [{ source: 'im', thread: 'topic/disk' }],
    inputs: [],
    assignments: [{
      id: `asg_${id}_1`,
      state: 'running',
      speculative: false,
      workerSessionId: `worker_${id}`,
      startedAt: at,
    }],
    speculative: false,
    originTriggerId: `trg_${id}`,
    createdAt: at,
    ...overrides,
  }
}

function createRuntime(home: string, opts: Partial<RuntimeOptions> = {}): Runtime {
  const runtime = Runtime.create({
    home,
    model: new StubLiveModel(),
    jobDelayMs: 0,
    watchdogIntervalMs: 600_000,
    stuckMs: 600_000,
    ...opts,
  })
  runtimes.push(runtime)
  return runtime
}

function recoveredInputs(ticket: Ticket) {
  return ticket.inputs.filter(input => input.kind === 'context' && input.text?.startsWith('RECOVERED:'))
}

function recoveredEvents(runtime: Runtime) {
  return runtime.store.listEvents().filter(event =>
    event.type === 'assignment.ended'
    && (event.payload as { kind?: string }).kind === 'recovered')
}

describe('restart recovery', () => {
  it('ends the running assignment once, queues one replacement, appends one RECOVERED prompt, and relaunches', () => {
    const home = tempHome()
    const runtime = createRuntime(home)
    runtime.store.putDoc('ticket', 'ticket_crashed', runningTicket('ticket_crashed'))
    const launch = vi.spyOn(runtime.harness, 'launch').mockImplementation(() => Promise.resolve())

    runtime.start({ assessPending: false })

    const ticket = runtime.store.getDoc<Ticket>('ticket', 'ticket_crashed')!
    expect(ticket.assignments).toHaveLength(2)
    expect(ticket.assignments[0]).toMatchObject({ id: 'asg_ticket_crashed_1', state: 'ended' })
    expect(ticket.assignments[1]?.state).toBe('pending')
    expect(ticket.assignments[1]?.workerSessionId).toBeUndefined()
    expect(recoveredInputs(ticket)).toHaveLength(1)
    expect(recoveredEvents(runtime)).toHaveLength(1)
    expect(launch).toHaveBeenCalledTimes(1)
    expect(launch.mock.calls[0]?.[0]?.id).toBe('ticket_crashed')
  })

  it('persists the ended assignment and replacement before calling harness.launch', () => {
    const home = tempHome()
    const runtime = createRuntime(home)
    runtime.store.putDoc('ticket', 'ticket_persisted', runningTicket('ticket_persisted'))
    let observed: Ticket | undefined
    vi.spyOn(runtime.harness, 'launch').mockImplementation(ticket => {
      observed = runtime.store.getDoc<Ticket>('ticket', ticket.id)
      return Promise.resolve()
    })

    runtime.start({ assessPending: false })

    expect(observed).toBeDefined()
    expect(observed?.assignments[0]?.state).toBe('ended')
    expect(observed?.assignments.at(-1)?.state).toBe('pending')
    expect(observed ? recoveredInputs(observed) : []).toHaveLength(1)
    expect(observed?.assignments).toHaveLength(2)
  })

  it('recovers a live running ticket while leaving ended, paused, and merely-pending tickets untouched', () => {
    const home = tempHome()
    const runtime = createRuntime(home)
    const live = runningTicket('ticket_live')
    const ended = runningTicket('ticket_ended', {
      ended: { at: new Date().toISOString(), outcome: 'stopped', by: 'human' },
    })
    const paused = runningTicket('ticket_paused', {
      collab: {
        paused: { at: new Date().toISOString(), by: 'human' },
        guidance: [],
        resumes: [],
      },
    })
    const pending = runningTicket('ticket_pending', {
      assignments: [{ id: 'asg_ticket_pending_1', state: 'pending', speculative: false }],
    })
    for (const ticket of [live, ended, paused, pending]) runtime.store.putDoc('ticket', ticket.id, ticket)
    const launch = vi.spyOn(runtime.harness, 'launch').mockImplementation(() => Promise.resolve())

    runtime.start({ assessPending: false })

    expect(launch).toHaveBeenCalledTimes(1)
    expect(launch.mock.calls[0]?.[0]?.id).toBe('ticket_live')
    expect(recoveredEvents(runtime)).toHaveLength(1)
    const recovered = runtime.store.getDoc<Ticket>('ticket', 'ticket_live')!
    expect(recovered.assignments).toHaveLength(2)
    expect(recoveredInputs(recovered)).toHaveLength(1)
    for (const seeded of [ended, paused, pending]) {
      const current = runtime.store.getDoc<Ticket>('ticket', seeded.id)!
      expect(current.assignments).toEqual(seeded.assignments)
      expect(recoveredInputs(current)).toHaveLength(0)
      expect(current.ended).toEqual(seeded.ended)
      expect(current.collab).toEqual(seeded.collab)
    }
  })

  it('defers under MockModel without mutating interrupted state or launching', () => {
    const home = tempHome()
    const runtime = createRuntime(home, { model: new MockModel() })
    runtime.store.putDoc('ticket', 'ticket_mock', runningTicket('ticket_mock'))
    const launch = vi.spyOn(runtime.harness, 'launch').mockImplementation(() => Promise.resolve())

    runtime.start({ assessPending: false })

    const ticket = runtime.store.getDoc<Ticket>('ticket', 'ticket_mock')!
    expect(ticket.assignments).toHaveLength(1)
    expect(ticket.assignments[0]?.state).toBe('running')
    expect(ticket.inputs).toHaveLength(0)
    expect(recoveredEvents(runtime)).toHaveLength(0)
    expect(launch).not.toHaveBeenCalled()
    expect(runtime.log.text()).toContain('[recovery] deferred reason=mock-model')
  })

  it('is idempotent across repeated start() calls and a process restart', async () => {
    const home = tempHome()
    const first = createRuntime(home)
    first.store.putDoc('ticket', 'ticket_twice', runningTicket('ticket_twice'))
    const launch = vi.spyOn(first.harness, 'launch').mockImplementation(() => Promise.resolve())

    first.start({ assessPending: false })
    first.start({ assessPending: false })

    const afterFirst = first.store.getDoc<Ticket>('ticket', 'ticket_twice')!
    expect(afterFirst.assignments).toHaveLength(2)
    expect(recoveredInputs(afterFirst)).toHaveLength(1)
    expect(launch).toHaveBeenCalledTimes(1)

    await shutdown(first)
    const second = createRuntime(home)
    const relaunch = vi.spyOn(second.harness, 'launch').mockImplementation(() => Promise.resolve())
    second.start({ assessPending: false })

    const afterRestart = second.store.getDoc<Ticket>('ticket', 'ticket_twice')!
    expect(afterRestart.assignments).toHaveLength(2)
    expect(recoveredInputs(afterRestart)).toHaveLength(1)
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('never writes an environment credential into recovery state, events, or logs', () => {
    const home = tempHome()
    const runtime = createRuntime(home, { env: { ...process.env, DS_AGENT_API_KEY: SECRET } })
    runtime.store.putDoc('ticket', 'ticket_secret', runningTicket('ticket_secret'))
    vi.spyOn(runtime.harness, 'launch').mockImplementation(() => Promise.resolve())

    runtime.start({ assessPending: false })

    const ticket = runtime.store.getDoc<Ticket>('ticket', 'ticket_secret')!
    expect(recoveredInputs(ticket)).toHaveLength(1)
    const evidence = [
      JSON.stringify(ticket),
      JSON.stringify(runtime.store.listEvents()),
      runtime.log.text(),
    ].join('\n')
    expect(evidence).not.toContain(SECRET)
  })
})

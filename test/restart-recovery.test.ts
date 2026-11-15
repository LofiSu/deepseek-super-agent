import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginDelegateOperation,
  EXTERNAL_OP_KIND,
  recordOutboxSendStart,
  UNKNOWN_OUTCOME_PREFIX,
  type ExternalOperationRecord,
} from '../src/core/external-effects.ts'
import type { SemanticHit } from '../src/ingress/filter.ts'
import { MockModel, type Completion, type CompletionRequest, type Model } from '../src/harness/model.ts'
import { Runtime, type RuntimeOptions } from '../src/runtime.ts'
import type { OutboxRow, Ticket } from '../src/shared/types.ts'
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

/** Records every prompt so a test can prove what the Worker turn actually saw. */
class CapturingModel implements Model {
  readonly name = 'CapturingLiveModel'
  readonly prompts: string[] = []

  classify(): SemanticHit {
    return { pass: true, strength: 'explicit', reason: 'capture' }
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    this.prompts.push(request.messages.map(message => message.content).join('\n'))
    return { text: 'done' }
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

function unknownApprovals(ticket: Ticket) {
  return (ticket.collab?.approvals ?? []).filter(approval =>
    approval.status === 'pending' && approval.action.startsWith(UNKNOWN_OUTCOME_PREFIX))
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

  it('defers under MockModel without finalizing a started delegate operation', () => {
    const home = tempHome()
    const runtime = createRuntime(home, { model: new MockModel() })
    runtime.store.putDoc('ticket', 'ticket_mock_delegate', runningTicket('ticket_mock_delegate'))
    const started = beginDelegateOperation({
      store: runtime.store,
      ticketId: 'ticket_mock_delegate',
      assignmentId: 'asg_ticket_mock_delegate_1',
      sessionId: 'worker_ticket_mock_delegate',
      agent: 'a',
      task: 'do the work',
      now: new Date().toISOString(),
    })
    const launch = vi.spyOn(runtime.harness, 'launch').mockImplementation(() => Promise.resolve())

    runtime.start({ assessPending: false })

    const ticket = runtime.store.getDoc<Ticket>('ticket', 'ticket_mock_delegate')!
    expect(ticket.assignments).toHaveLength(1)
    expect(ticket.assignments[0]?.state).toBe('running')
    expect(ticket.inputs).toHaveLength(0)
    expect(ticket.collab?.approvals ?? []).toHaveLength(0)
    expect(unknownApprovals(ticket)).toHaveLength(0)
    const ops = runtime.store.listDocs<ExternalOperationRecord>(EXTERNAL_OP_KIND)
    expect(ops).toHaveLength(1)
    expect(ops[0]?.id).toBe(started.id)
    expect(ops[0]?.phase).toBe('started')
    expect(launch).not.toHaveBeenCalled()
    expect(runtime.log.text()).toContain('[recovery] deferred reason=mock-model')
    expect(runtime.log.text()).not.toContain('[recovery] uncertain external effects')
  })

  it('defers under MockModel without flipping a started outbox send to unknown', () => {
    const home = tempHome()
    const runtime = createRuntime(home, { model: new MockModel() })
    runtime.store.putDoc('ticket', 'ticket_mock_outbox', runningTicket('ticket_mock_outbox'))
    const at = new Date().toISOString()
    const row: OutboxRow = {
      id: 'obx_mock_inflight',
      replyId: 'rpl_mock_inflight',
      ticketId: 'ticket_mock_outbox',
      channel: 'im',
      thread: 'im:topic/disk',
      target: { provider: 'feishu', chat_id: 'topic/disk' },
      text: 'still sending',
      status: 'pending',
      idempotencyKey: 'idem_mock_inflight',
      createdAt: at,
    }
    runtime.store.enqueueOutbox(row)
    expect(runtime.store.claimOutbox(row.id)).toBe(true)
    recordOutboxSendStart(runtime.store, row, at)
    const launch = vi.spyOn(runtime.harness, 'launch').mockImplementation(() => Promise.resolve())

    runtime.start({ assessPending: false })

    const current = runtime.store.listOutbox().find(item => item.id === row.id)!
    expect(current.status).toBe('sending')
    const op = runtime.store.getDoc<ExternalOperationRecord>(EXTERNAL_OP_KIND, `outbox_${row.id}`)
    expect(op?.phase).toBe('started')
    const ticket = runtime.store.getDoc<Ticket>('ticket', 'ticket_mock_outbox')!
    expect(ticket.assignments[0]?.state).toBe('running')
    expect(unknownApprovals(ticket)).toHaveLength(0)
    expect(launch).not.toHaveBeenCalled()
    expect(runtime.log.text()).toContain('[recovery] deferred reason=mock-model')
    expect(runtime.log.text()).not.toContain('[recovery] uncertain external effects')
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
    // The replacement committed before the mocked crash was still pending, so
    // a real restart relaunches that same Assignment at-least-once (N3).
    expect(relaunch).toHaveBeenCalledTimes(1)
    expect(relaunch.mock.calls[0]?.[0]?.id).toBe('ticket_twice')
  })

  it('scans once per Runtime so a second start() does not end the live relaunch', async () => {
    const home = tempHome()
    const runtime = createRuntime(home, { singleSession: true })
    runtime.store.putDoc('ticket', 'ticket_live_again', runningTicket('ticket_live_again'))

    runtime.start({ assessPending: false })
    await runtime.jobsSettled()
    const relaunched = runtime.store.getDoc<Ticket>('ticket', 'ticket_live_again')!
    expect(relaunched.assignments).toHaveLength(2)
    expect(relaunched.assignments.at(-1)?.state).toBe('running')

    runtime.start({ assessPending: false })
    await runtime.jobsSettled()

    const after = runtime.store.getDoc<Ticket>('ticket', 'ticket_live_again')!
    expect(after.assignments).toHaveLength(2)
    expect(after.assignments.at(-1)?.state).toBe('running')
    expect(recoveredInputs(after)).toHaveLength(1)
    expect(recoveredEvents(runtime)).toHaveLength(1)
  })

  it('logs sync and async launch failures and keeps every recovered ticket consistent', async () => {
    const home = tempHome()
    const runtime = createRuntime(home)
    runtime.store.putDoc('ticket', 'ticket_sync_throw', runningTicket('ticket_sync_throw'))
    runtime.store.putDoc('ticket', 'ticket_async_reject', runningTicket('ticket_async_reject'))
    vi.spyOn(runtime.harness, 'launch').mockImplementation(ticket => {
      if (ticket.id === 'ticket_sync_throw') throw new Error('sync launch boom')
      return Promise.reject(new Error('async launch boom'))
    })

    expect(() => runtime.start({ assessPending: false })).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(runtime.log.text()).toContain('[recovery] launch failed ticketId=ticket_sync_throw')
    expect(runtime.log.text()).toContain('[recovery] launch failed ticketId=ticket_async_reject')
    for (const id of ['ticket_sync_throw', 'ticket_async_reject']) {
      const ticket = runtime.store.getDoc<Ticket>('ticket', id)!
      expect(ticket.assignments).toHaveLength(2)
      expect(ticket.assignments.at(-1)?.state).toBe('pending')
      expect(recoveredInputs(ticket)).toHaveLength(1)
    }
  })

  it('keeps an earlier ticket relaunch_scheduled when a later async launch fails', async () => {
    const home = tempHome()
    const runtime = createRuntime(home)
    runtime.store.putDoc('ticket', 'ticket_ok', runningTicket('ticket_ok'))
    runtime.store.putDoc('ticket', 'ticket_rejects', runningTicket('ticket_rejects'))
    const launched: string[] = []
    vi.spyOn(runtime.harness, 'launch').mockImplementation(ticket => {
      launched.push(ticket.id)
      return launched.length === 2
        ? Promise.reject(new Error('second launch boom'))
        : Promise.resolve()
    })

    runtime.start({ assessPending: false })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(launched).toHaveLength(2)
    const boundary = runtime.recoveryBoundary()!
    expect(boundary.tickets.find(t => t.ticketId === launched[0])?.transition).toBe('relaunch_scheduled')
    expect(boundary.tickets.find(t => t.ticketId === launched[1])?.transition).toBe('launch_failed')
  })

  it('does not revert a later ticket relaunch_scheduled when an earlier async launch fails', async () => {
    const home = tempHome()
    const runtime = createRuntime(home)
    runtime.store.putDoc('ticket', 'ticket_early_fail', runningTicket('ticket_early_fail'))
    runtime.store.putDoc('ticket', 'ticket_later_ok', runningTicket('ticket_later_ok'))
    const launched: string[] = []
    vi.spyOn(runtime.harness, 'launch').mockImplementation(ticket => {
      launched.push(ticket.id)
      return launched.length === 1
        ? Promise.reject(new Error('first launch boom'))
        : Promise.resolve()
    })

    runtime.start({ assessPending: false })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(launched).toHaveLength(2)
    const boundary = runtime.recoveryBoundary()!
    expect(boundary.tickets.find(t => t.ticketId === launched[0])?.transition).toBe('launch_failed')
    expect(boundary.tickets.find(t => t.ticketId === launched[1])?.transition).toBe('relaunch_scheduled')
  })

  it('keeps launch_failed persisted after start() when harness.launch throws synchronously', () => {
    const home = tempHome()
    const runtime = createRuntime(home)
    runtime.store.putDoc('ticket', 'ticket_sync_only', runningTicket('ticket_sync_only'))
    vi.spyOn(runtime.harness, 'launch').mockImplementation(() => {
      throw new Error('sync launch boom')
    })

    runtime.start({ assessPending: false })

    const boundary = runtime.recoveryBoundary()!
    expect(boundary.tickets.find(t => t.ticketId === 'ticket_sync_only')?.transition).toBe('launch_failed')
  })

  it('records every async launch failure instead of the last snapshot winning', async () => {
    const home = tempHome()
    const runtime = createRuntime(home)
    runtime.store.putDoc('ticket', 'ticket_fail_a', runningTicket('ticket_fail_a'))
    runtime.store.putDoc('ticket', 'ticket_fail_b', runningTicket('ticket_fail_b'))
    vi.spyOn(runtime.harness, 'launch').mockImplementation(() => Promise.reject(new Error('launch boom')))

    runtime.start({ assessPending: false })
    await new Promise(resolve => setTimeout(resolve, 0))

    const boundary = runtime.recoveryBoundary()!
    for (const id of ['ticket_fail_a', 'ticket_fail_b']) {
      expect(boundary.tickets.find(t => t.ticketId === id)?.transition).toBe('launch_failed')
    }
  })

  it('relaunches a pending replacement left by a crash before launch without duplicating state', () => {
    const home = tempHome()
    const runtime = createRuntime(home)
    const at = new Date().toISOString()
    const crashed = runningTicket('ticket_committed', {
      assignments: [
        { id: 'asg_ticket_committed_old', state: 'ended', speculative: false, endedAt: at },
        { id: 'asg_ticket_committed_replacement', state: 'pending', speculative: false },
      ],
      inputs: [{
        id: 'input_ticket_committed_recovered',
        kind: 'context',
        text: 'RECOVERED: assignment asg_ticket_committed_old was interrupted by a process restart.',
        at,
        human: false,
      }],
    })
    const ordinary = runningTicket('ticket_ordinary_pending', {
      assignments: [{ id: 'asg_ticket_ordinary_pending_1', state: 'pending', speculative: false }],
    })
    runtime.store.putDoc('ticket', crashed.id, crashed)
    runtime.store.putDoc('ticket', ordinary.id, ordinary)
    const launch = vi.spyOn(runtime.harness, 'launch').mockImplementation(() => Promise.resolve())

    runtime.start({ assessPending: false })

    expect(launch).toHaveBeenCalledTimes(1)
    expect(launch.mock.calls[0]?.[0]?.id).toBe('ticket_committed')
    const current = runtime.store.getDoc<Ticket>('ticket', 'ticket_committed')!
    expect(current.assignments).toEqual(crashed.assignments)
    expect(recoveredInputs(current)).toHaveLength(1)
    expect(recoveredEvents(runtime)).toHaveLength(0)
    expect(runtime.store.getDoc<Ticket>('ticket', ordinary.id)).toEqual(ordinary)
  })

  it('isolates a malformed ticket so other interrupted tickets still recover', () => {
    const home = tempHome()
    const runtime = createRuntime(home)
    const malformed = { ...runningTicket('ticket_malformed'), assignments: null }
    runtime.store.putDoc('ticket', 'ticket_malformed', malformed)
    runtime.store.putDoc('ticket', 'ticket_good', runningTicket('ticket_good'))

    const recovered = runtime.engine.recoverInterrupted()

    expect(recovered.map(item => item.ticketId)).toEqual(['ticket_good'])
    expect(runtime.log.text()).toContain('[recovery] ticket failed ticketId=ticket_malformed')
    const good = runtime.store.getDoc<Ticket>('ticket', 'ticket_good')!
    expect(good.assignments).toHaveLength(2)
    expect(recoveredInputs(good)).toHaveLength(1)
  })

  it('injects the RECOVERED notice and interrupted assignment id into the Worker prompt only on relaunch', async () => {
    const home = tempHome()
    const model = new CapturingModel()
    const runtime = createRuntime(home, { model, singleSession: true })
    runtime.store.putDoc('ticket', 'ticket_prompt', runningTicket('ticket_prompt'))
    runtime.start({ assessPending: false })

    const normal = runningTicket('ticket_normal', {
      assignments: [{ id: 'asg_ticket_normal_1', state: 'pending', speculative: false }],
    })
    runtime.store.putDoc('ticket', normal.id, normal)
    const normalLaunch = runtime.harness.launch(runtime.store.getDoc<Ticket>('ticket', normal.id)!)
    await Promise.all([normalLaunch, runtime.jobsSettled()])

    expect(model.prompts).toHaveLength(2)
    const recoveryPrompt = model.prompts.find(prompt => prompt.includes('ticketId=ticket_prompt'))
    const normalPrompt = model.prompts.find(prompt => prompt.includes('ticketId=ticket_normal'))
    expect(recoveryPrompt).toContain('RECOVERED:')
    expect(recoveryPrompt).toContain('asg_ticket_prompt_1')
    expect(normalPrompt).toBeDefined()
    expect(normalPrompt).not.toContain('RECOVERED:')
  })

  it('persists a recovery boundary record with ticket transitions', () => {
    const home = tempHome()
    const runtime = createRuntime(home)
    runtime.store.putDoc('ticket', 'ticket_boundary', runningTicket('ticket_boundary'))
    vi.spyOn(runtime.harness, 'launch').mockImplementation(() => Promise.resolve())

    runtime.start({ assessPending: false })

    const boundary = runtime.recoveryBoundary()
    expect(boundary?.outcome).toBe('completed')
    expect(boundary?.model).toBe('StubLiveModel')
    expect(boundary?.tickets.some(t => t.ticketId === 'ticket_boundary')).toBe(true)
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

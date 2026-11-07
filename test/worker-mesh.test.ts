import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { bindRolePorts } from '../src/core/role-ports.ts'
import { LocalEnv } from '../src/env/local-env.ts'
import { Harness } from '../src/harness/loop.ts'
import { WorkerMeshRegistry } from '../src/harness/mesh.ts'
import { SessionJournal } from '../src/harness/session.ts'
import { ToolRegistry } from '../src/harness/tools.ts'
import type { Runtime } from '../src/runtime.ts'
import { DEFAULT_MESH_QUEUE } from '../src/runtime.ts'
import type { Ticket } from '../src/shared/types.ts'
import { freshRuntime, shutdown } from './fixtures.ts'
import { field, lastPrompt, ScriptedModel } from './scripted-model.ts'

describe('T47 WorkerMeshRegistry', () => {
  it('registers nodes and picks one with free capacity', () => {
    const mesh = new WorkerMeshRegistry()
    mesh.register({ id: 'a', capacity: 1 })
    mesh.register({ id: 'b', capacity: 2 })
    expect(mesh.pickNode('t1')?.id).toBe('a')
    expect(mesh.pickNode('t2')?.id).toBe('b')
    expect(mesh.inFlight('a')).toBe(1)
    expect(mesh.inFlight('b')).toBe(1)
  })

  it('returns no node when full and frees capacity on release', () => {
    const mesh = new WorkerMeshRegistry([{ id: 'a', capacity: 1 }])
    expect(mesh.pickNode('t1')?.id).toBe('a')
    expect(mesh.pickNode('t2')).toBeUndefined()
    mesh.release('t1')
    expect(mesh.pickNode('t2')?.id).toBe('a')
    expect(mesh.inFlight('a')).toBe(1)
  })

  it('does not double count a ticket and rejects invalid nodes', () => {
    const mesh = new WorkerMeshRegistry()
    expect(() => mesh.register({ id: 'a', capacity: 0 })).toThrow()
    mesh.register({ id: 'a', capacity: 1 })
    expect(() => mesh.register({ id: 'a', capacity: 1 })).toThrow()
    expect(mesh.pickNode('t1')?.id).toBe('a')
    expect(mesh.pickNode('t1')?.id).toBe('a')
    expect(mesh.inFlight('a')).toBe(1)
  })

  it('skips offline nodes and frees slots when a node leaves', () => {
    const mesh = new WorkerMeshRegistry([{ id: 'a', capacity: 1 }, { id: 'b', capacity: 1 }])
    mesh.markOnline('a', false)
    expect(mesh.pickNode('t1')?.id).toBe('b')
    expect(mesh.pickNode('t2')).toBeUndefined()
    mesh.unregister('b')
    expect(mesh.inFlight('b')).toBe(0)
    expect(mesh.pickNode('t2')).toBeUndefined()
  })
})

/** Mesh enforcement needs a real Harness; the registry above stays pure accounting. */
describe('Worker mesh capacity backpressure (P1-3)', () => {
  const runtimes: Runtime[] = []
  const gates: Gate[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const gate of gates.splice(0)) gate.release()
    for (const runtime of runtimes.splice(0)) await shutdown(runtime)
  })

  interface Gate {
    promise: Promise<void>
    release: () => void
  }

  function gate(): Gate {
    let release!: () => void
    const promise = new Promise<void>(resolve => {
      release = resolve
    })
    const value = { promise, release }
    gates.push(value)
    return value
  }

  function meshEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DS_AGENT_MESH_CAPACITY: '1',
      DS_AGENT_INSTANCE_ID: 'mesh-test',
      ...extra,
    }
    delete env.DS_AGENT_ROUTER_MODEL
    delete env.DS_AGENT_WORKER_MODEL
    delete env.DS_AGENT_WATCHDOG_MODEL
    delete env.DS_AGENT_SHARDS
    return env
  }

  /**
   * One Worker turn makes two model calls: report_to_router (which ends the
   * ticket) then a final text. `events` records the interleaving so a test can
   * prove the next Worker did not start before the current *turn* settled.
   */
  function meshModel(
    events: string[],
    held: Map<string, Gate>,
    kinds: Map<string, string> = new Map(),
  ): ScriptedModel {
    const calls = new Map<string, number>()
    return new ScriptedModel(async request => {
      if (request.role !== 'worker') return { text: 'router-ok' }
      const prompt = lastPrompt(request)
      const ticketId = field(prompt, 'ticketId')
      const n = (calls.get(ticketId) ?? 0) + 1
      calls.set(ticketId, n)
      events.push(`${ticketId}:call${n}`)
      const gated = held.get(ticketId)
      if (n === 1 && gated) await gated.promise
      // `plain` ends the turn with text and no report, so neither the Ticket
      // nor its Assignment ends and the mesh slot stays reserved.
      if (kinds.get(ticketId) === 'plain') return { text: 'worker-done' }
      const reported = request.messages.some(message =>
        message.role === 'tool' && message.name === 'report_to_router')
      if (!reported) {
        const kind = kinds.get(ticketId) ?? 'ready'
        return {
          toolCalls: [{
            id: `report_${ticketId}_${n}`,
            name: 'report_to_router',
            args: { ticketId, text: `${kind}: done`, deliver: kind === 'ready', kind },
          }],
        }
      }
      events.push(`${ticketId}:done`)
      return { text: 'worker-done' }
    })
  }

  function start(
    events: string[],
    held: Map<string, Gate>,
    env: NodeJS.ProcessEnv = {},
    kinds: Map<string, string> = new Map(),
  ): Runtime {
    const runtime = freshRuntime({
      model: meshModel(events, held, kinds),
      env: meshEnv(env),
      singleSession: true,
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
    })
    runtimes.push(runtime)
    return runtime
  }

  /** Persist a ticket without launching it; the test decides when to launch. */
  function createTicket(runtime: Runtime, triggerId: string): { triggerId: string; ticketId: string } {
    runtime.engine.receive(imTrigger({
      id: triggerId,
      thread: `topic/${triggerId}`,
      text: '@ds-agent please fix the login timeout on checkout',
    }), { shards: ['default'] })
    const decision = runtime.engine.evaluateDue()[0]
    if (!decision?.ticketId) throw new Error('expected a ticket')
    return { triggerId, ticketId: decision.ticketId }
  }

  function load(runtime: Runtime, ticketId: string): Ticket {
    const ticket = runtime.store.getDoc<Ticket>('ticket', ticketId)
    if (!ticket) throw new Error(`missing ticket ${ticketId}`)
    return ticket
  }

  async function tick(ms = 10): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms))
  }

  async function waitFor(predicate: () => boolean, label: string, ms = 2_000): Promise<void> {
    const deadline = Date.now() + ms
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
      await tick(5)
    }
  }

  /** Resolve true when `promise` settles before the deadline, without leaking the timer. */
  async function settlesWithin(promise: Promise<unknown>, ms = 1_000): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), ms)
    })
    try {
      return await Promise.race([promise.then(() => true, () => true), deadline])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Like `meshModel`, but names the prompt kind so a test can prove a queued
   * `TASK` turn never runs after its Ticket ended.
   */
  function orderModel(events: string[], held: Map<string, Gate>): ScriptedModel {
    const calls = new Map<string, number>()
    return new ScriptedModel(async request => {
      if (request.role !== 'worker') return { text: 'router-ok' }
      const prompt = lastPrompt(request)
      const ticketId = field(prompt, 'ticketId')
      const mode = prompt.startsWith('TASK')
        ? 'task'
        : prompt.startsWith('FOLLOWUP') ? 'followup' : 'other'
      const key = `${ticketId}:${mode}`
      const n = (calls.get(key) ?? 0) + 1
      calls.set(key, n)
      events.push(`${key}:call${n}`)
      const gated = held.get(ticketId)
      if (gated && n === 1) await gated.promise
      const reported = request.messages.some(message =>
        message.role === 'tool' && message.name === 'report_to_router')
      if (!reported) {
        return {
          toolCalls: [{
            id: `report_${ticketId}_${mode}_${n}`,
            name: 'report_to_router',
            args: { ticketId, text: 'ready: done', deliver: true, kind: 'ready' },
          }],
        }
      }
      return { text: 'worker-done' }
    })
  }

  function startOrdered(
    events: string[],
    held: Map<string, Gate>,
    capacity: number,
  ): Runtime {
    const runtime = freshRuntime({
      model: orderModel(events, held),
      env: meshEnv({ DS_AGENT_MESH_CAPACITY: String(capacity) }),
      singleSession: true,
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
    })
    runtimes.push(runtime)
    return runtime
  }

  it('does not start a queued Worker that a fanned-out follow-up ends', async () => {
    const events: string[] = []
    const held = new Map<string, Gate>()
    const runtime = startOrdered(events, held, 2)
    const a = createTicket(runtime, 'trg_order_a')
    const c = createTicket(runtime, 'trg_order_c')
    const b = createTicket(runtime, 'trg_order_b')
    runtime.lifecycle.subscribe('ticket.ended', event => {
      events.push(`${(event.payload as { ticketId: string }).ticketId}:ended`)
    })
    const gateA = gate()
    const gateC = gate()
    held.set(a.ticketId, gateA)
    held.set(c.ticketId, gateC)

    // A and C occupy both mesh slots; B cannot start and must queue.
    const launches = [
      runtime.harness.launch(load(runtime, a.ticketId)),
      runtime.harness.launch(load(runtime, c.ticketId)),
    ]
    await waitFor(
      () => events.some(event => event.startsWith(`${a.ticketId}:task`))
        && events.some(event => event.startsWith(`${c.ticketId}:task`)),
      'both mesh slots occupied',
    )
    const queued = runtime.harness.launch(load(runtime, b.ticketId))
    await tick(20)
    expect(runtime.log.text()).toContain(`mesh.queued ticketId=${b.ticketId}`)
    expect(events.some(event => event.startsWith(`${b.ticketId}:`))).toBe(false)

    // Free C's slot while its Worker turn is still unwinding. `activeWorkers`
    // suppresses that pump, leaving capacity available when B reports.
    runtime.engine.stop(c.ticketId, 'free one slot for the queued report')

    // A human follow-up on B's thread fans out to the open, queued ticket.
    // Its deliver() turn reports ready, which ends B.
    runtime.ingest(imTrigger({
      id: 'trg_order_followup',
      thread: 'topic/trg_order_b',
      text: '@ds-agent please fix the login timeout on checkout',
    }))

    await expect(settlesWithin(queued, 2_000)).resolves.toBe(true)
    gateA.release()
    gateC.release()
    await Promise.all(launches)
    await runtime.jobsSettled()

    const endedAt = events.indexOf(`${b.ticketId}:ended`)
    expect(endedAt).toBeGreaterThanOrEqual(0)
    expect(events.slice(endedAt + 1).filter(event => event.startsWith(`${b.ticketId}:task`))).toEqual([])
    expect(events.filter(event => event.startsWith(`${b.ticketId}:task`))).toEqual([])

    const bEvents = runtime.store.listEvents()
      .filter(event => (event.payload as { ticketId?: string }).ticketId === b.ticketId)
    expect(bEvents.filter(event => event.type === 'assignment.started')).toEqual([])
    expect(bEvents.filter(event => event.type === 'assignment.placed')).toEqual([])
    expect(load(runtime, b.ticketId).ended?.outcome).toBe('ready')
    expect(load(runtime, b.ticketId).assignments.at(-1)?.state).toBe('ended')
  })

  it('direct Harness.deliver cannot resurrect the queued ticket it just ended', async () => {
    const events: string[] = []
    const held = new Map<string, Gate>()
    const runtime = startOrdered(events, held, 1)
    const a = createTicket(runtime, 'trg_direct_a')
    const b = createTicket(runtime, 'trg_direct_b')
    runtime.lifecycle.subscribe('ticket.ended', event => {
      events.push(`${(event.payload as { ticketId: string }).ticketId}:ended`)
    })
    const gateA = gate()
    held.set(a.ticketId, gateA)

    const firstLaunch = runtime.harness.launch(load(runtime, a.ticketId))
    await waitFor(() => events.includes(`${a.ticketId}:task:call1`), 'first worker start')
    const queued = runtime.harness.launch(load(runtime, b.ticketId))
    await tick(20)
    expect(runtime.log.text()).toContain(`mesh.queued ticketId=${b.ticketId}`)

    // Free A's slot while its turn is still held; A's own release is deferred.
    runtime.engine.stop(a.ticketId, 'free one slot for the direct delivery')
    const delivered = runtime.harness.deliver(b.ticketId, imTrigger({
      id: 'trg_direct_followup',
      thread: 'topic/trg_direct_b',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    await expect(settlesWithin(queued, 2_000)).resolves.toBe(true)
    await delivered
    gateA.release()
    await firstLaunch
    await runtime.jobsSettled()

    expect(events.filter(event => event.startsWith(`${b.ticketId}:task`))).toEqual([])
    const bEvents = runtime.store.listEvents()
      .filter(event => (event.payload as { ticketId?: string }).ticketId === b.ticketId)
    expect(bEvents.filter(event => event.type === 'assignment.started')).toEqual([])
    expect(bEvents.filter(event => event.type === 'assignment.placed')).toEqual([])
    expect(load(runtime, b.ticketId).ended?.outcome).toBe('ready')
  })

  it('falls back to the default queue limit for invalid programmatic values', () => {
    for (const invalid of [Number.NaN, -1, 2.5, Number.POSITIVE_INFINITY]) {
      const runtime = freshRuntime({
        model: meshModel([], new Map()),
        env: meshEnv(),
        singleSession: true,
        meshQueue: invalid,
        watchdogIntervalMs: 60_000,
      })
      runtimes.push(runtime)
      expect(runtime.log.text()).toContain(`meshQueue=${DEFAULT_MESH_QUEUE}`)
    }
  })

  it('keeps an explicit zero queue limit (reject instead of queue)', () => {
    const runtime = freshRuntime({
      model: meshModel([], new Map()),
      env: meshEnv(),
      singleSession: true,
      meshQueue: 0,
      watchdogIntervalMs: 60_000,
    })
    runtimes.push(runtime)
    expect(runtime.log.text()).toContain('meshQueue=0')
  })

  it('does not start a second Worker while the first turn is running at capacity 1', async () => {
    const events: string[] = []
    const held = new Map<string, Gate>()
    const runtime = start(events, held)
    const a = createTicket(runtime, 'trg_capacity_a')
    const b = createTicket(runtime, 'trg_capacity_b')
    const first = gate()
    held.set(a.ticketId, first)

    const firstLaunch = runtime.harness.launch(load(runtime, a.ticketId))
    await waitFor(() => events.includes(`${a.ticketId}:call1`), 'first worker start')
    expect(events.some(event => event.startsWith(`${b.ticketId}:`))).toBe(false)

    const secondLaunch = runtime.harness.launch(load(runtime, b.ticketId))
    await tick(30)
    expect(events.some(event => event.startsWith(`${b.ticketId}:`))).toBe(false)
    expect(runtime.log.text()).toContain('[mesh] mesh.queued')
    expect(runtime.metrics.snapshot().counters['mesh.queued']).toBe(1)

    first.release()
    await Promise.all([firstLaunch, secondLaunch])

    // The second worker starts only after the first Worker *turn* settled,
    // even though the mesh slot was released mid-turn when the ticket ended.
    expect(events.indexOf(`${a.ticketId}:done`)).toBeLessThan(events.indexOf(`${b.ticketId}:call1`))
    const starts = events.filter(event => event.endsWith(':call1')).map(event => event.split(':')[0])
    expect(starts).toEqual([a.ticketId, b.ticketId])
    expect(runtime.metrics.snapshot().counters['mesh.dequeued']).toBe(1)
  })

  it('frees the slot when a Worker ends its assignment but leaves the ticket open', async () => {
    const events: string[] = []
    const held = new Map<string, Gate>()
    const kinds = new Map<string, string>()
    const runtime = start(events, held, {}, kinds)
    const a = createTicket(runtime, 'trg_assign_a')
    const b = createTicket(runtime, 'trg_assign_b')
    // `failed` ends the Assignment; the Ticket stays open (no onTicketEnded).
    kinds.set(a.ticketId, 'failed')
    const first = gate()
    held.set(a.ticketId, first)

    const firstLaunch = runtime.harness.launch(load(runtime, a.ticketId))
    await waitFor(() => events.includes(`${a.ticketId}:call1`), 'first worker start')
    const secondLaunch = runtime.harness.launch(load(runtime, b.ticketId))
    await tick(30)
    expect(events.some(event => event.startsWith(`${b.ticketId}:`))).toBe(false)

    first.release()
    await Promise.all([firstLaunch, secondLaunch])

    const leftOpen = load(runtime, a.ticketId)
    expect(leftOpen.ended).toBeUndefined()
    expect(leftOpen.assignments.at(-1)?.state).toBe('ended')
    expect(events.some(event => event.startsWith(`${b.ticketId}:call1`))).toBe(true)
  })

  it('persists placement through the Engine, not by writing the ticket in the Harness', async () => {
    const events: string[] = []
    const runtime = start(events, new Map())
    const a = createTicket(runtime, 'trg_place_a')
    // The Harness gets a Store that refuses putDoc. Engine callbacks use the
    // real Store, so a direct write from the Harness would fail the test.
    const guarded = new Proxy(runtime.store, {
      get(target, prop) {
        if (prop === 'putDoc') {
          return () => {
            throw new Error('Harness must not call store.putDoc')
          }
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const tools = new ToolRegistry({
      store: runtime.store,
      ports: bindRolePorts(runtime.engine),
      env: new LocalEnv(path.join(runtime.home, 'workspaces')),
      metrics: runtime.metrics,
      redact: text => text,
      log: () => undefined,
      scheduleJob: () => undefined,
      routerTurn: async () => undefined,
    })
    const harness = new Harness({
      model: meshModel(events, new Map()),
      tools,
      store: guarded,
      assignmentStarted: (ticketId, assignmentId, sessionId) => {
        runtime.engine.assignmentStarted(ticketId, assignmentId, sessionId)
      },
      assignmentPlaced: (ticketId, assignmentId, node) => {
        runtime.engine.assignmentPlaced(ticketId, assignmentId, node)
      },
      journal: new SessionJournal(
        path.join(runtime.home, 'sessions'),
        runtime.store,
        () => undefined,
      ),
      metrics: runtime.metrics,
      redact: text => text,
      log: line => runtime.log.info(line),
      jobDelayMs: 0,
      singleSession: true,
      pickNode: (ticketId, _ticket) => runtime.workerMesh.pickNode(ticketId)?.id,
    })

    await harness.launch(load(runtime, a.ticketId))

    expect(events.some(event => event.startsWith(`${a.ticketId}:call1`))).toBe(true)
    expect(load(runtime, a.ticketId).assignments.at(-1)?.node).toBe('mesh-test')
    const placed = runtime.store.listEvents().filter(event => event.type === 'assignment.placed')
    expect(placed).toHaveLength(1)
    expect(placed[0]?.payload).toMatchObject({ ticketId: a.ticketId, node: 'mesh-test' })
    expect(runtime.log.text()).toContain('[engine] Assignments.placed')
  })

  it('jobsSettled waits for queued Workers instead of dropping them', async () => {
    const events: string[] = []
    const held = new Map<string, Gate>()
    const runtime = start(events, held)
    const a = createTicket(runtime, 'trg_settle_a')
    const b = createTicket(runtime, 'trg_settle_b')
    const first = gate()
    held.set(a.ticketId, first)

    const firstLaunch = runtime.harness.launch(load(runtime, a.ticketId))
    await waitFor(() => events.includes(`${a.ticketId}:call1`), 'first worker start')
    const secondLaunch = runtime.harness.launch(load(runtime, b.ticketId))
    await tick(30)
    expect(runtime.log.text()).toContain('[mesh] mesh.queued')

    // Ordinary settle must not clear the queue (that is shutdown-only).
    const settled = runtime.jobsSettled()
    first.release()
    await expect(settlesWithin(settled, 2_000)).resolves.toBe(true)
    await Promise.all([firstLaunch, secondLaunch])

    const starts = events.filter(event => event.endsWith(':call1')).map(event => event.split(':')[0])
    expect(starts).toEqual([a.ticketId, b.ticketId])
    expect(runtime.metrics.snapshot().counters['mesh.queue_drained']).toBe(0)
    expect(runtime.log.text()).not.toContain('mesh.queue_drained')
  })

  it('pumps queued Workers in FIFO order', async () => {
    const events: string[] = []
    const held = new Map<string, Gate>()
    const runtime = start(events, held)
    const a = createTicket(runtime, 'trg_fifo_a')
    const b = createTicket(runtime, 'trg_fifo_b')
    const c = createTicket(runtime, 'trg_fifo_c')
    const first = gate()
    held.set(a.ticketId, first)

    const firstLaunch = runtime.harness.launch(load(runtime, a.ticketId))
    await waitFor(() => events.includes(`${a.ticketId}:call1`), 'first worker start')
    const secondLaunch = runtime.harness.launch(load(runtime, b.ticketId))
    const thirdLaunch = runtime.harness.launch(load(runtime, c.ticketId))
    await tick(30)
    expect(runtime.log.text()).toContain('[mesh] mesh.queued')

    first.release()
    await Promise.all([firstLaunch, secondLaunch, thirdLaunch])

    const starts = events.filter(event => event.endsWith(':call1')).map(event => event.split(':')[0])
    expect(starts).toEqual([a.ticketId, b.ticketId, c.ticketId])
    expect(runtime.metrics.snapshot().counters['mesh.dequeued']).toBe(2)
  })

  it('skips a queued ticket that ended or paused before its turn', async () => {
    const events: string[] = []
    const held = new Map<string, Gate>()
    const runtime = start(events, held)
    const a = createTicket(runtime, 'trg_skip_a')
    const ended = createTicket(runtime, 'trg_skip_ended')
    const paused = createTicket(runtime, 'trg_skip_paused')
    const open = createTicket(runtime, 'trg_skip_open')
    const first = gate()
    held.set(a.ticketId, first)

    const launches = [a, ended, paused, open]
      .map(ticket => runtime.harness.launch(load(runtime, ticket.ticketId)))
    await waitFor(() => events.includes(`${a.ticketId}:call1`), 'first worker start')
    await tick(20)

    runtime.engine.stop(ended.ticketId, 'closed while queued')
    runtime.pause(paused.ticketId, { reason: 'held while queued' })

    first.release()
    await Promise.all(launches)

    expect(events.some(event => event.startsWith(`${ended.ticketId}:`))).toBe(false)
    expect(events.some(event => event.startsWith(`${paused.ticketId}:`))).toBe(false)
    expect(events.some(event => event.startsWith(`${open.ticketId}:call1`))).toBe(true)
    expect(load(runtime, ended.ticketId).ended?.outcome).toBe('stopped')
    expect(load(runtime, paused.ticketId).collab?.paused).toBeDefined()
  })

  it('rejects a launch from a full queue without throwing or running the Worker', async () => {
    const events: string[] = []
    const held = new Map<string, Gate>()
    const runtime = start(events, held, { DS_AGENT_MESH_QUEUE: '1' })
    const a = createTicket(runtime, 'trg_full_a')
    const b = createTicket(runtime, 'trg_full_b')
    const c = createTicket(runtime, 'trg_full_c')
    const first = gate()
    held.set(a.ticketId, first)

    const firstLaunch = runtime.harness.launch(load(runtime, a.ticketId))
    await waitFor(() => events.includes(`${a.ticketId}:call1`), 'first worker start')
    const secondLaunch = runtime.harness.launch(load(runtime, b.ticketId))
    await tick(20)

    // Queue limit 1: this launch is rejected rather than queued, and resolves.
    const rejected = runtime.harness.launch(load(runtime, c.ticketId))
    await expect(settlesWithin(rejected)).resolves.toBe(true)
    expect(events.some(event => event.startsWith(`${c.ticketId}:`))).toBe(false)
    expect(runtime.log.text()).toContain('mesh.queue-full')
    expect(runtime.metrics.snapshot().counters['mesh.queue_rejected']).toBe(1)

    first.release()
    await Promise.all([firstLaunch, secondLaunch])
    expect(events.some(event => event.startsWith(`${c.ticketId}:`))).toBe(false)
    expect(load(runtime, c.ticketId).ended).toBeUndefined()
  })

  it('drain resolves queued work without starting it or hanging', async () => {
    const events: string[] = []
    const held = new Map<string, Gate>()
    const runtime = start(events, held)
    const a = createTicket(runtime, 'trg_drain_a')
    const b = createTicket(runtime, 'trg_drain_b')
    const c = createTicket(runtime, 'trg_drain_c')
    const first = gate()
    held.set(a.ticketId, first)

    const firstLaunch = runtime.harness.launch(load(runtime, a.ticketId))
    await waitFor(() => events.includes(`${a.ticketId}:call1`), 'first worker start')
    const queued = [
      runtime.harness.launch(load(runtime, b.ticketId)),
      runtime.harness.launch(load(runtime, c.ticketId)),
    ]
    await tick(20)

    const draining = runtime.harness.drain()
    await expect(settlesWithin(Promise.all(queued))).resolves.toBe(true)
    expect(events.some(event => event.startsWith(`${b.ticketId}:`))).toBe(false)
    expect(events.some(event => event.startsWith(`${c.ticketId}:`))).toBe(false)
    expect(runtime.log.text()).toContain('mesh.queue_drained count=2')
    expect(runtime.metrics.snapshot().counters['mesh.queue_drained']).toBe(2)

    first.release()
    await expect(settlesWithin(draining)).resolves.toBe(true)
    await firstLaunch
    expect(load(runtime, b.ticketId).ended).toBeUndefined()
    expect(load(runtime, c.ticketId).ended).toBeUndefined()
  })

  /** Rewrite the queued Ticket's latest Assignment to simulate a committed snapshot. */
  function patchLatestAssignment(
    runtime: Runtime,
    ticketId: string,
    patch: Partial<Ticket['assignments'][number]>,
  ): void {
    const ticket = load(runtime, ticketId)
    const assignments = [...ticket.assignments]
    const latest = assignments.at(-1)
    if (!latest) throw new Error(`missing assignment ${ticketId}`)
    assignments[assignments.length - 1] = { ...latest, ...patch }
    runtime.store.putDoc('ticket', ticketId, { ...ticket, assignments })
  }

  /**
   * Queue a Worker behind a held one, rewrite its committed snapshot, then free
   * the slot so `pump()` reads the new state. The skip branch must resolve the
   * queued launch without ever starting a Worker for that Ticket.
   */
  async function expectQueuedSkip(
    reason: string,
    mutate: (runtime: Runtime, ticketId: string) => void,
  ): Promise<void> {
    const events: string[] = []
    const held = new Map<string, Gate>()
    const runtime = start(events, held)
    const blocker = createTicket(runtime, `trg_skip_${reason}_blocker`)
    const queuedTicket = createTicket(runtime, `trg_skip_${reason}_queued`)
    const first = gate()
    held.set(blocker.ticketId, first)

    const firstLaunch = runtime.harness.launch(load(runtime, blocker.ticketId))
    await waitFor(() => events.includes(`${blocker.ticketId}:call1`), 'blocker worker start')
    const queued = runtime.harness.launch(load(runtime, queuedTicket.ticketId))
    await tick(20)
    expect(runtime.log.text()).toContain(`mesh.queued ticketId=${queuedTicket.ticketId}`)

    mutate(runtime, queuedTicket.ticketId)
    first.release()
    await expect(settlesWithin(queued)).resolves.toBe(true)
    await firstLaunch
    await runtime.jobsSettled()

    expect(runtime.log.text()).toContain(`skipped=${reason}`)
    expect(events.some(event => event.startsWith(`${queuedTicket.ticketId}:`))).toBe(false)
    if (runtime.store.isOpen) {
      const started = runtime.store.listEvents().filter(event =>
        event.type === 'assignment.started'
        && (event.payload as { ticketId?: string }).ticketId === queuedTicket.ticketId)
      expect(started).toEqual([])
    }
  }

  it('queueState skips a queued Worker when the Store closed', async () => {
    await expectQueuedSkip('store-closed', runtime => runtime.store.close())
  })

  it('queueState skips a queued Worker whose Ticket document is gone', async () => {
    await expectQueuedSkip('ticket-missing', (runtime, ticketId) => {
      runtime.store.deleteDoc('ticket', ticketId)
    })
  })

  it('queueState skips a queued Worker with no Assignment', async () => {
    await expectQueuedSkip('no-assignment', (runtime, ticketId) => {
      const ticket = load(runtime, ticketId)
      runtime.store.putDoc('ticket', ticketId, { ...ticket, assignments: [] })
    })
  })

  it('queueState skips a queued Worker whose latest Assignment ended', async () => {
    await expectQueuedSkip('assignment-ended', (runtime, ticketId) => {
      patchLatestAssignment(runtime, ticketId, {
        state: 'ended',
        endedAt: new Date().toISOString(),
      })
    })
  })

  it('queueState skips a queued Worker whose latest Assignment reported failed', async () => {
    await expectQueuedSkip('assignment-failed', (runtime, ticketId) => {
      patchLatestAssignment(runtime, ticketId, {
        state: 'running',
        report: { kind: 'failed', text: 'executor failed' },
      })
    })
  })

  it('queueState skips a queued Worker whose latest Assignment reported blocked', async () => {
    await expectQueuedSkip('assignment-blocked', (runtime, ticketId) => {
      patchLatestAssignment(runtime, ticketId, {
        state: 'running',
        report: { kind: 'blocked', text: 'needs a human' },
      })
    })
  })

  it('cleans up a synchronous throw on the non-queued start path', async () => {
    const events: string[] = []
    const held = new Map<string, Gate>()
    const runtime = start(events, held)
    const failed = createTicket(runtime, 'trg_start_throw')
    const later = createTicket(runtime, 'trg_start_later')

    const originalStarted = runtime.engine.assignmentStarted.bind(runtime.engine)
    vi.spyOn(runtime.engine, 'assignmentStarted').mockImplementation((ticketId, assignmentId, sessionId) => {
      if (ticketId === failed.ticketId) throw new Error('placement exploded')
      originalStarted(ticketId, assignmentId, sessionId)
    })

    // The launch must resolve; the active marker and the mesh slot picked before
    // the throw must not leak.
    await expect(runtime.harness.launch(load(runtime, failed.ticketId))).resolves.toBeUndefined()
    expect(runtime.log.text()).toContain(
      `[harness] worker failed ticketId=${failed.ticketId} error=Error: placement exploded`,
    )
    expect(runtime.workerMesh.inFlight('mesh-test')).toBe(0)
    expect(events.some(event => event.startsWith(`${failed.ticketId}:`))).toBe(false)

    // Hold the only slot so the next launch queues. Nothing else can pump it.
    expect(runtime.workerMesh.pickNode('manual-hold')?.id).toBe('mesh-test')
    const queued = runtime.harness.launch(load(runtime, later.ticketId))
    await tick(20)
    expect(runtime.log.text()).toContain(`mesh.queued ticketId=${later.ticketId}`)
    runtime.workerMesh.release('manual-hold')

    // If the failed start leaked its active marker, release() would no-op and
    // the queued Worker would never start.
    runtime.harness.release(failed.ticketId)
    await waitFor(() => events.some(event => event.startsWith(`${later.ticketId}:call1`)), 'queued worker start')
    await expect(settlesWithin(queued, 2_000)).resolves.toBe(true)
    expect(load(runtime, later.ticketId).ended?.outcome).toBe('ready')
  })

  it('pumps a queued Worker after a non-queued Worker turn rejects and releases its node', async () => {
    const events: string[] = []
    const held = new Map<string, Gate>()
    const kinds = new Map<string, string>()
    const runtime = start(events, held, {}, kinds)
    const a = createTicket(runtime, 'trg_pump_a')
    const b = createTicket(runtime, 'trg_pump_b')
    // A's Worker turn returns plain text: it reports nothing, so neither its
    // Ticket nor its Assignment ends and the picked mesh slot stays reserved
    // until `startNow`'s failure handler releases it.
    kinds.set(a.ticketId, 'plain')
    const gateA = gate()
    held.set(a.ticketId, gateA)

    // Reject only A's turn, after its Worker run finished: `run`'s finally
    // writes the idle session row. A model error would be caught and end the
    // turn cleanly, which never exercises this path.
    const originalUpsert = runtime.store.upsertSession.bind(runtime.store)
    vi.spyOn(runtime.store, 'upsertSession').mockImplementation(row => {
      if (row.id === `worker_${a.ticketId}` && row.status === 'idle') {
        throw new Error('worker run finally exploded')
      }
      originalUpsert(row)
    })

    const firstLaunch = runtime.harness.launch(load(runtime, a.ticketId))
    await waitFor(() => events.includes(`${a.ticketId}:call1`), 'first worker start')
    const secondLaunch = runtime.harness.launch(load(runtime, b.ticketId))
    await waitFor(
      () => runtime.log.text().includes(`mesh.queued ticketId=${b.ticketId}`),
      'queued worker parked',
    )
    expect(events.some(event => event.startsWith(`${b.ticketId}:`))).toBe(false)

    // This is the only event that can free the slot: no stop, follow-up,
    // delivery, or host release() runs for A or B.
    gateA.release()
    await expect(settlesWithin(firstLaunch, 2_000)).resolves.toBe(true)
    expect(runtime.log.text()).toContain(
      `[harness] worker failed ticketId=${a.ticketId} error=Error: worker run finally exploded`,
    )

    // Without the pump the launch stays parked on a free node forever.
    await expect(settlesWithin(secondLaunch, 2_000)).resolves.toBe(true)
    expect(events.some(event => event.startsWith(`${b.ticketId}:call1`))).toBe(true)
    expect(load(runtime, b.ticketId).ended?.outcome).toBe('ready')
    expect(runtime.workerMesh.inFlight('mesh-test')).toBe(0)
    expect(runtime.metrics.snapshot().counters['mesh.dequeued']).toBe(1)
  })

  it('releases the mesh node when a non-queued Worker turn rejects asynchronously', async () => {
    const events: string[] = []
    const held = new Map<string, Gate>()
    const runtime = start(events, held)
    const failed = createTicket(runtime, 'trg_async_fail')
    const later = createTicket(runtime, 'trg_async_later')

    // Memory recall runs inside the scheduled Worker callback, so throwing here
    // rejects the promise `startWorkerTurn` returned instead of throwing
    // synchronously out of `launch`.
    const originalQuery = runtime.longTermMemory.query.bind(runtime.longTermMemory)
    vi.spyOn(runtime.longTermMemory, 'query').mockImplementation(query => {
      if (query.ticketId === failed.ticketId) throw new Error('worker turn exploded')
      return originalQuery(query)
    })

    // The launch must resolve; the mesh slot picked before the turn rejected
    // must not leak.
    await expect(runtime.harness.launch(load(runtime, failed.ticketId))).resolves.toBeUndefined()
    expect(runtime.log.text()).toContain(
      `[harness] worker failed ticketId=${failed.ticketId} error=Error: worker turn exploded`,
    )
    expect(runtime.workerMesh.inFlight('mesh-test')).toBe(0)
    expect(events.some(event => event.startsWith(`${failed.ticketId}:`))).toBe(false)

    // A later Worker still gets the only node and runs to completion.
    await runtime.harness.launch(load(runtime, later.ticketId))
    expect(events.some(event => event.startsWith(`${later.ticketId}:call1`))).toBe(true)
    expect(load(runtime, later.ticketId).ended?.outcome).toBe('ready')
    expect(runtime.workerMesh.inFlight('mesh-test')).toBe(0)
  })
})

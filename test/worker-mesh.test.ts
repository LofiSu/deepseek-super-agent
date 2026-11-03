import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { WorkerMeshRegistry } from '../src/harness/mesh.ts'
import type { Runtime } from '../src/runtime.ts'
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
})

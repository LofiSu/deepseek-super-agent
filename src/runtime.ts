import path from 'node:path'
import type {
  CollaborationView,
  InterveneInput,
  InterveneOutcome,
  PauseInput,
  PauseOutcome,
  ResumeOutcome,
} from './core/collab.ts'
import { Engine } from './core/engine.ts'
import { bindRolePorts } from './core/role-ports.ts'
import type { Host } from './core/host.ts'
import { LocalEnv } from './env/local-env.ts'
import { redactSecrets, secretValues } from './env/sanitize.ts'
import { Daemon } from './harness/daemon.ts'
import { Harness } from './harness/loop.ts'
import { MachineRegistry } from './harness/machines.ts'
import { TeamRegistry } from './harness/team.ts'
import { createModelFromEnv, roleModelsFromEnv, type Model } from './harness/model.ts'
import { SessionJournal } from './harness/session.ts'
import { ToolRegistry } from './harness/tools.ts'
import { filterTrigger } from './ingress/filter.ts'
import { RouterShardRegistry, type RouterShard } from './ingress/shards.ts'
import { inlineOrSpill } from './memory/recall.ts'
import { SpillBackedLongTermMemory } from './memory/long-term.ts'
import { Metrics } from './metrics/metrics.ts'
import { A2ARouter, type A2ADelivery, type A2AEnvelope } from './channels/a2a.ts'
import { LifecycleBus } from './core/lifecycle.ts'
import { WorkerMeshRegistry } from './harness/mesh.ts'
import { Logger } from './shared/log.ts'
import type { Disposition, ReceiveResult, Ticket, Trigger, TriggerTrust } from './shared/types.ts'
import { Store } from './store/sqlite.ts'
import { Watchdog } from './watchdog/watchdog.ts'
import { settleSpeculation } from './speculate/silent.ts'

export interface RuntimeOptions {
  home: string
  model?: Model
  /** Per-role overrides (T07/T10). Live mode also reads DS_AGENT_ROUTER_MODEL etc. */
  models?: Partial<Record<'router' | 'worker' | 'watchdog', Model>>
  jobDelayMs?: number
  watchdogIntervalMs?: number
  stuckMs?: number
  /**
   * Delay before Eval runs after ingest. 0 (default) evaluates synchronously.
   * A positive window lets same-thread triggers that arrive during the window
   * fold into one Eval batch — the batching path from T02/T08.
   */
  batchWindowMs?: number
  now?: () => string
  /** Environment for the LocalEnv allowlist, secret redaction, model ids, and instance settings. */
  env?: NodeJS.ProcessEnv
  /** Local A2A address and mesh node id. Defaults to `DS_AGENT_INSTANCE_ID` or `local`. */
  instanceId?: string
  /** Worker slots this process advertises. Defaults to `DS_AGENT_MESH_CAPACITY` or 4. */
  meshCapacity?: number
  /** Extra Router shards. `DS_AGENT_SHARDS` JSON is merged in as well. */
  routerShards?: RouterShard[]
  /** T45 bake-off baseline: run one Worker chain with no Router turn. */
  singleSession?: boolean
  /**
   * Long-term memory retention. Overrides `DS_AGENT_MEMORY_MAX_ENTRIES` /
   * `DS_AGENT_MEMORY_MAX_AGE_DAYS`; 0 disables that dimension.
   */
  memoryRetention?: MemoryRetention
}

export interface MemoryRetention {
  maxEntries?: number
  maxAgeDays?: number
}

/** Conservative defaults: bound index growth without dropping recent history. */
export const DEFAULT_MEMORY_MAX_ENTRIES = 1000
export const DEFAULT_MEMORY_MAX_AGE_DAYS = 90

/**
 * Parse `DS_AGENT_MEMORY_MAX_ENTRIES` / `DS_AGENT_MEMORY_MAX_AGE_DAYS` as
 * non-negative integers. Empty, non-numeric, negative, or non-integer values
 * fall back to the documented defaults (1000 entries, 90 days). `0` disables
 * that dimension. Programmatic `memoryRetention` overrides win.
 */
export function memoryRetentionFromEnv(
  env: NodeJS.ProcessEnv,
  override: MemoryRetention = {},
): Required<MemoryRetention> {
  return {
    maxEntries: override.maxEntries
      ?? parseNonNegativeInt(env.DS_AGENT_MEMORY_MAX_ENTRIES, DEFAULT_MEMORY_MAX_ENTRIES),
    maxAgeDays: override.maxAgeDays
      ?? parseNonNegativeInt(env.DS_AGENT_MEMORY_MAX_AGE_DAYS, DEFAULT_MEMORY_MAX_AGE_DAYS),
  }
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

class RedactingLogger extends Logger {
  constructor(private readonly clean: (line: string) => string) {
    super()
  }

  override info(line: string): void {
    super.info(this.clean(line))
  }
}

export class Runtime {
  readonly log: Logger
  readonly store: Store
  readonly engine: Engine
  readonly harness: Harness
  readonly watchdog: Watchdog
  readonly daemon: Daemon
  readonly model: Model
  readonly metrics: Metrics
  readonly home: string
  /** Worker-internal Team registry. */
  readonly teams: TeamRegistry
  /** Local A2A address and Worker mesh node id. */
  readonly instanceId: string
  readonly routerShards: RouterShardRegistry
  readonly workerMesh: WorkerMeshRegistry
  readonly longTermMemory: SpillBackedLongTermMemory
  /** Read-model lifecycle events for panels and CLI views. */
  readonly lifecycle: LifecycleBus
  readonly a2aRouter: A2ARouter

  private readonly redact: (text: string) => string
  private readonly batchWindowMs: number
  private evalTimer: ReturnType<typeof setTimeout> | undefined

  private constructor(parts: {
    home: string
    log: Logger
    store: Store
    engine: Engine
    harness: Harness
    watchdog: Watchdog
    daemon: Daemon
    model: Model
    metrics: Metrics
    teams: TeamRegistry
    instanceId: string
    routerShards: RouterShardRegistry
    workerMesh: WorkerMeshRegistry
    longTermMemory: SpillBackedLongTermMemory
    lifecycle: LifecycleBus
    a2aRouter: A2ARouter
    redact: (text: string) => string
    batchWindowMs: number
  }) {
    this.home = parts.home
    this.log = parts.log
    this.store = parts.store
    this.engine = parts.engine
    this.harness = parts.harness
    this.watchdog = parts.watchdog
    this.daemon = parts.daemon
    this.model = parts.model
    this.metrics = parts.metrics
    this.teams = parts.teams
    this.instanceId = parts.instanceId
    this.routerShards = parts.routerShards
    this.workerMesh = parts.workerMesh
    this.longTermMemory = parts.longTermMemory
    this.lifecycle = parts.lifecycle
    this.a2aRouter = parts.a2aRouter
    this.redact = parts.redact
    this.batchWindowMs = parts.batchWindowMs
  }

  static create(opts: RuntimeOptions): Runtime {
    const baseEnv = opts.env ?? process.env
    const secrets = secretValues(baseEnv)
    const redact = (text: string) => redactSecrets(text, secrets)
    const log = new RedactingLogger(redact)
    const model = opts.model ?? createModelFromEnv(baseEnv)
    const models = { ...roleModelsFromEnv(baseEnv, model), ...(opts.models ?? {}) }
    const store = new Store(opts.home)
    const metrics = new Metrics(opts.home)
    const now = opts.now ?? (() => new Date().toISOString())
    const instanceId = opts.instanceId?.trim() || baseEnv.DS_AGENT_INSTANCE_ID?.trim() || 'local'
    const rawCapacity = opts.meshCapacity ?? Number(baseEnv.DS_AGENT_MESH_CAPACITY)
    const meshCapacity = Number.isSafeInteger(rawCapacity) && rawCapacity > 0 ? rawCapacity : 4
    const routerShards = new RouterShardRegistry()
    routerShards.register({ id: 'default' })
    // Optional JSON config so CLI/demo users can shard without writing code:
    // DS_AGENT_SHARDS='[{"id":"github","filter":"source:github"}]'
    const configured = baseEnv.DS_AGENT_SHARDS
    if (configured?.trim()) {
      try {
        const shards = JSON.parse(configured) as unknown
        if (!Array.isArray(shards)) throw new Error('expected a JSON array')
        for (const shard of shards) routerShards.register(shard as RouterShard)
        log.info(`[routing] shards configured count=${shards.length}`)
      } catch (error) {
        log.info(`[routing] DS_AGENT_SHARDS ignored: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    for (const shard of opts.routerShards ?? []) routerShards.register(shard)
    const workerMesh = new WorkerMeshRegistry([{ id: instanceId, capacity: meshCapacity }])
    // Retention keeps the durable index bounded: 1000 entries / 90 days by
    // default, with 0 disabling either dimension.
    const retention = memoryRetentionFromEnv(baseEnv, opts.memoryRetention)
    const longTermMemory = new SpillBackedLongTermMemory(store, redact, retention)
    const lifecycle = new LifecycleBus()
    const a2aRouter = new A2ARouter(store)
    log.info(`[runtime] instance=${instanceId} meshCapacity=${meshCapacity} shards=${routerShards.list().length}`)
    log.info(`[runtime] model=${model.name}`)
    const host: Host = {
      repo: store,
      now,
      metrics,
      log: line => log.info(line),
      scope: {
        // Admission is computed here every time. `trigger.meta` is untrusted and
        // never short-circuits the filter (docs/REVIEW.md C1).
        admit: trigger => {
          const verdict = filterTrigger(trigger, model)
          if (verdict.action === 'drop') return { listened: false, reason: `${verdict.layer}:${verdict.reason}` }
          return { listened: true, reason: verdict.reason }
        },
      },
      onQueued: (threadKey, triggerId, pending) => {
        log.info(`[ingress] batch-hook thread=${threadKey} triggerId=${triggerId} pending=${pending.length}`)
      },
      onTicketCreated: ticket => {
        lifecycle.publish({
          kind: 'ticket.created',
          payload: {
            ticketId: ticket.id,
            title: ticket.title,
            speculative: ticket.speculative,
            threads: ticket.threadKeys,
          },
        })
      },
      onTicketEnded: ticket => {
        // One durable memory entry per finished ticket; the next ticket recalls it.
        const entry = longTermMemory.remember(ticket)
        workerMesh.release(ticket.id)
        lifecycle.publish({
          kind: 'ticket.ended',
          payload: {
            ticketId: ticket.id,
            outcome: ticket.ended?.outcome ?? 'unknown',
            by: ticket.ended?.by ?? 'unknown',
            memoryId: entry.id,
          },
        })
        metrics.increment('memory.remembered')
        log.info(`[memory] ticket.ended ticketId=${ticket.id} memory=${entry.id}`)
      },
    }
    const engine = new Engine(host)
    const env = new LocalEnv(path.join(opts.home, 'workspaces'), { env: baseEnv })
    const journal = new SessionJournal(path.join(opts.home, 'sessions'), store, line => log.info(line))
    const late: { harness?: Harness } = {}
    const teams = new TeamRegistry(store)
    const machines = new MachineRegistry()
    const tools = new ToolRegistry({
      store,
      ports: bindRolePorts(engine),
      env,
      metrics,
      redact,
      log: line => log.info(line),
      scheduleJob: job => {
        if (!late.harness) throw new Error('harness is not ready')
        late.harness.scheduleJob(job)
      },
      routerTurn: prompt => {
        if (!late.harness) throw new Error('harness is not ready')
        return late.harness.routerTurn(prompt)
      },
      nudge: (sessionId, ticketId) => {
        journal.append(sessionId, {
          role: 'user',
          kind: 'nudge',
          content: `watchdog nudge ticketId=${ticketId}`,
        })
        store.addEvent('watchdog.nudge', { ticketId, sessionId })
      },
      teams,
    })
    const harness = new Harness({
      model,
      models,
      tools,
      store,
      assignmentStarted: (ticketId, assignmentId, sessionId) => {
        engine.assignmentStarted(ticketId, assignmentId, sessionId)
      },
      journal,
      metrics,
      redact,
      log: line => log.info(line),
      jobDelayMs: opts.jobDelayMs ?? 40,
      teams,
      takeGuidance: (ticketId, audience) => engine.takeGuidance(ticketId, audience),
      singleSession: opts.singleSession === true,
      routerSessions: ticket => {
        const disposition = store.getDoc<Disposition>('disposition', ticket.originTriggerId)
        return disposition?.shards?.length ? disposition.shards : ['default']
      },
      pickNode: ticketId => {
        const node = workerMesh.pickNode(ticketId)
        if (node) metrics.increment('mesh.assigned')
        return node?.id
      },
      memory: ticket => {
        const entries = longTermMemory.query({
          ticketId: ticket.id,
          text: ticket.title,
          limit: 3,
        })
        if (entries.length) metrics.increment('memory.recalled', entries.length)
        return entries.map(entry => ({ id: entry.id, spillId: entry.spillId, text: entry.text }))
      },
    })
    late.harness = harness
    const watchdog = new Watchdog({
      store,
      engine,
      journal,
      metrics,
      log: line => log.info(line),
      intervalMs: opts.watchdogIntervalMs ?? 15_000,
      stuckMs: opts.stuckMs ?? 60_000,
      // A watchdog fail is a terminal path too: settle the speculative workdir.
      settle: (sessionId, verdict) => settleSpeculation(env, sessionId, verdict),
    })
    const daemon = new Daemon(watchdog, line => log.info(line), machines)
    const runtime = new Runtime({
      home: opts.home,
      log,
      store,
      engine,
      harness,
      watchdog,
      daemon,
      model,
      metrics,
      teams,
      instanceId,
      routerShards,
      workerMesh,
      longTermMemory,
      lifecycle,
      a2aRouter,
      redact,
      batchWindowMs: opts.batchWindowMs ?? 0,
    })
    // Local A2A endpoint: an envelope addressed to this instance becomes a normal,
    // untrusted Trigger and goes through the same ingress filter.
    a2aRouter.register(instanceId, envelope => {
      const trigger = a2aTrigger(envelope, store, now())
      if (!trigger) {
        log.info(`[a2a] ignored envelope=${envelope.id ?? '-'} reason=no-text`)
        return
      }
      metrics.increment('a2a.delivery')
      log.info(`[a2a] received id=${envelope.id ?? '-'} from=${envelope.from} triggerId=${trigger.id}`)
      runtime.ingest(trigger)
    })
    return runtime
  }

  start(): void {
    this.daemon.start()
  }

  /**
   * Ingress, then Engine.receive, then Eval for anything that was not a subscription bypass.
   * Text is redacted before it is spilled or persisted. Admission and spill grants
   * travel in `trust`, an ingress-owned sidecar — never in `trigger.meta`.
   */
  ingest(trigger: Trigger): ReceiveResult {
    if (this.store.getDoc<Trigger>('trigger', trigger.id)) {
      const result = this.engine.receive(trigger)
      this.log.info(`[engine] Intake.receive id=${trigger.id} result=${result}`)
      return result
    }
    const safe: Trigger = { ...trigger, text: this.redact(trigger.text) }
    const verdict = filterTrigger(safe, this.model)
    if (verdict.action === 'pass') this.metrics.increment('ingress.admit')
    else this.metrics.increment('ingress.drop')
    this.log.info(
      `[ingress] two-level fast=${verdict.fast} semantic=${verdict.semantic} model=${this.model.name} action=${verdict.action} layer=${verdict.layer}`,
    )
    let incoming: Trigger = { ...safe, meta: {} }
    let trust: TriggerTrust = {}
    if (verdict.action === 'pass') {
      const recall = inlineOrSpill(safe.text, body => this.store.putSpill(body))
      if (recall.spillId) {
        this.log.info(`[memory] Inline/Spill chain-of-recall spillId=${recall.spillId} bytes=${recall.bytes}`)
      }
      // A channel hint may only ask for silence (speculate). It cannot buy admission.
      const shards = this.routerShards.route(safe)
      this.metrics.increment('router.shard', shards.length)
      this.log.info(`[routing] shards=${shards.join(',')} triggerId=${safe.id}`)
      trust = {
        spillId: recall.spillId,
        strength: trigger.speculate === true ? 'maybe' : verdict.strength,
        filterText: safe.text,
        shards,
      }
      incoming = { ...safe, text: recall.inline, meta: {} }
    }
    const result = this.engine.receive(incoming, trust)
    this.log.info(`[engine] Intake.receive id=${incoming.id} result=${result}`)
    if (result === 'filtered') {
      this.log.info('noise dropped')
      return result
    }
    if (result !== 'stored') return result
    this.scheduleEval()
    const disposition = this.store.getDoc<Disposition>('disposition', incoming.id)
    for (const ticketId of disposition?.fanout ?? []) this.harness.deliver(ticketId, incoming, trust.spillId)
    return result
  }

  /**
   * Send an A2A envelope to another instance (T50). Delivery is in-process;
   * a cross-process adapter moves the same envelope over its own transport.
   */
  sendA2A(to: string, body: unknown): A2ADelivery {
    const delivery = this.a2aRouter.send({ from: this.instanceId, to, body })
    this.metrics.increment('a2a.delivery')
    this.log.info(`[a2a] sent id=${delivery.envelope.id ?? '-'} to=${to} status=${delivery.status}`)
    return delivery
  }

  /** T49 read-model event. A panel subscribes to the bus; it never holds a Session. */
  private publish(kind: string, payload: unknown): void {
    this.lifecycle.publish({ kind, payload })
  }

  /** Evaluate now, or after the batch window. Public so a caller can force the window closed. */
  flushEvals(): void {
    if (this.evalTimer) {
      clearTimeout(this.evalTimer)
      this.evalTimer = undefined
    }
    if (!this.store.isOpen) return
    for (const decision of this.engine.evaluateDue()) {
      // Gate runs before any worker. ignore, stop, and unavailable do not launch.
      if (decision.kind === 'accept' && decision.ticketId) {
        const ticket = this.store.getDoc<Ticket>('ticket', decision.ticketId)
        if (ticket) this.harness.launch(ticket)
      }
    }
  }

  private scheduleEval(): void {
    if (this.batchWindowMs <= 0) {
      this.flushEvals()
      return
    }
    if (this.evalTimer) return
    this.evalTimer = setTimeout(() => {
      this.evalTimer = undefined
      this.flushEvals()
    }, this.batchWindowMs)
    this.evalTimer.unref?.()
  }

  /** Freeze a live ticket. Persisted in SQLite; the Harness reads it before each step. */
  pause(ticketId: string, input: PauseInput = {}): PauseOutcome {
    const outcome = this.engine.pause(ticketId, input)
    if (outcome.changed) {
      this.publish('ticket.paused', {
        ticketId,
        at: outcome.ticket.collab?.paused?.at,
        by: outcome.ticket.collab?.paused?.by,
      })
    }
    return outcome
  }

  /** Record human guidance (and pause by default) for the next Router/Worker turn. */
  intervene(ticketId: string, text: string, input: InterveneInput = {}): InterveneOutcome {
    const outcome = this.engine.intervene(ticketId, text, input)
    this.publish('ticket.guidance', {
      ticketId,
      guidanceId: outcome.guidance.id,
      paused: outcome.paused,
    })
    return outcome
  }

  /**
   * Clear the pause and run the RESUME turns in this process.
   * A paused ticket in another process picks up the cleared flag on its next step.
   */
  async resume(ticketId: string, input: PauseInput = {}): Promise<ResumeOutcome> {
    const outcome = this.engine.resume(ticketId, input)
    if (outcome.resumed) this.publish('ticket.resumed', { ticketId, pausedAt: outcome.pausedAt })
    if (outcome.resumed && !outcome.ticket.ended) {
      await this.harness.resume(outcome.ticket)
    }
    return {
      ...outcome,
      ticket: this.store.getDoc<Ticket>('ticket', ticketId) ?? outcome.ticket,
    }
  }

  collaboration(ticketId: string): CollaborationView {
    return this.engine.collaboration(ticketId)
  }

  watchdogTurn(): Promise<void> {
    return this.harness.watchdogTurn()
  }

  drain(): Promise<void> {
    this.flushEvals()
    return this.harness.drain()
  }

  async jobsSettled(): Promise<void> {
    this.flushEvals()
    await this.harness.jobsSettled()
  }

  /** Wait for jobs, stop the daemon, and close SQLite. */
  async finish(): Promise<void> {
    this.flushEvals()
    await this.harness.jobsSettled()
    this.daemon.stop()
    if (this.store.isOpen) this.store.close()
  }
}

/**
 * T50: an envelope body is untrusted. It becomes a normal Trigger with an
 * `a2a` source and still passes the same fast/slow ingress filter.
 */
function a2aTrigger(envelope: A2AEnvelope, store: Store, at: string): Trigger | undefined {
  const body = envelope.body
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : undefined
  const text = typeof body === 'string' ? body : record?.text
  if (typeof text !== 'string' || !text.trim()) return undefined
  const thread = typeof record?.thread === 'string' && record.thread.trim()
    ? record.thread
    : `from/${envelope.from}`
  return {
    id: store.nextId('trigger'),
    source: 'a2a',
    threads: [{ source: 'a2a', id: thread }],
    actor: { source: 'a2a', id: envelope.from },
    // A2A has no authenticated human identity in this process. An adapter that
    // verifies a peer may mark the Trigger human after transport, never the body.
    human: false,
    addressed: 'direct',
    at,
    text,
    meta: {},
  }
}
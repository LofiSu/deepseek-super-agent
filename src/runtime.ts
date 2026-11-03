import path from 'node:path'
import type {
  CollaborationView,
  InterveneInput,
  InterveneOutcome,
  PauseInput,
  PauseOutcome,
  ResumeOutcome,
} from './core/collab.ts'
import { assessWithMainAgent } from './core/assessment.ts'
import { Engine } from './core/engine.ts'
import { arbitrateSubscribers } from './core/intake.ts'
import { withSessionRole } from './core/session-role.ts'
import { bindRolePorts } from './core/role-ports.ts'
import type { Host } from './core/host.ts'
import { LocalEnv } from './env/local-env.ts'
import { redactSecrets, secretValues } from './env/sanitize.ts'
import { Daemon } from './harness/daemon.ts'
import { Harness, normalizeQueueLimit } from './harness/loop.ts'
import { MachineRegistry } from './harness/machines.ts'
import { TeamRegistry } from './harness/team.ts'
import { createModelFromEnv, roleModelsFromEnv, type Model } from './harness/model.ts'
import { SessionJournal, workerSessionId } from './harness/session.ts'
import { ToolRegistry } from './harness/tools.ts'
import { filterTrigger, type AdmissionRules } from './ingress/filter.ts'
import { RouterShardRegistry, type RouterShard } from './ingress/shards.ts'
import { inlineOrSpill } from './memory/recall.ts'
import { SpillBackedLongTermMemory } from './memory/long-term.ts'
import { Metrics } from './metrics/metrics.ts'
import { A2ARouter, type A2ADelivery, type A2AEnvelope } from './channels/a2a.ts'
import { LifecycleBus } from './core/lifecycle.ts'
import { WorkerMeshRegistry } from './harness/mesh.ts'
import { Logger } from './shared/log.ts'
import type { Disposition, ReceiveResult, Thread, Ticket, Trigger, TriggerTrust } from './shared/types.ts'
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
  /**
   * Workers allowed to wait for a mesh slot. Defaults to `DS_AGENT_MESH_QUEUE`
   * or 100. `0` rejects instead of queueing.
   */
  meshQueue?: number
  /** Extra Router shards. `DS_AGENT_SHARDS` JSON is merged in as well. */
  routerShards?: RouterShard[]
  /** T45 bake-off baseline: run one Worker chain with no Router turn. */
  singleSession?: boolean
  /**
   * T16 deterministic admission rules. Overrides `DS_AGENT_ACTOR_ALLOWLIST`,
   * `DS_AGENT_GROUP_ALLOWLIST`, and `DS_AGENT_DROP_SELF`.
   */
  admission?: AdmissionRules
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
/** Bounded in-process Worker backlog when every mesh slot is busy. */
export const DEFAULT_MESH_QUEUE = 100

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

/** Comma-separated ids: trimmed, empty entries ignored, empty result is unset. */
function parseIdList(raw: string | undefined): string[] | undefined {
  if (raw == null || raw.trim() === '') return undefined
  const ids = raw.split(',').map(id => id.trim()).filter(id => id.length > 0)
  return ids.length ? ids : undefined
}

/** Admission log field: trimmed non-empty ids, or `-` when the list is empty. */
function logList(ids: string[] | undefined): string {
  const clean = (ids ?? []).map(id => id.trim()).filter(id => id.length > 0)
  return clean.length ? clean.join(',') : '-'
}

/** Trim and drop empty entries; an explicit `[]` stays `[]` so it disables the rule. */
function normalizeIdList(ids: string[] | undefined): string[] | undefined {
  if (ids === undefined) return undefined
  return ids.map(id => id.trim()).filter(id => id.length > 0)
}

/**
 * Resolve T16 admission rules. Explicit `admission` fields win over env; an
 * explicit empty list disables that rule. Unset lists stay `undefined` so the
 * fast path behaves exactly as before. Both sources are trimmed and empty
 * entries are dropped, so the resolved rules and the log line agree.
 */
export function admissionRulesFromEnv(
  env: NodeJS.ProcessEnv,
  override: AdmissionRules = {},
): AdmissionRules {
  return {
    actors: override.actors !== undefined
      ? normalizeIdList(override.actors)
      : parseIdList(env.DS_AGENT_ACTOR_ALLOWLIST),
    groups: override.groups !== undefined
      ? normalizeIdList(override.groups)
      : parseIdList(env.DS_AGENT_GROUP_ALLOWLIST),
    dropSelf: override.dropSelf !== undefined
      ? normalizeIdList(override.dropSelf)
      : parseIdList(env.DS_AGENT_DROP_SELF),
  }
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
  private readonly admission: AdmissionRules
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
    admission: AdmissionRules
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
    this.admission = parts.admission
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
    const env = new LocalEnv(path.join(opts.home, 'workspaces'), { env: baseEnv })
    const now = opts.now ?? (() => new Date().toISOString())
    const instanceId = opts.instanceId?.trim() || baseEnv.DS_AGENT_INSTANCE_ID?.trim() || 'local'
    const rawCapacity = opts.meshCapacity ?? Number(baseEnv.DS_AGENT_MESH_CAPACITY)
    const meshCapacity = Number.isSafeInteger(rawCapacity) && rawCapacity > 0 ? rawCapacity : 4
    const meshQueue = opts.meshQueue !== undefined
      ? normalizeQueueLimit(opts.meshQueue)
      : parseNonNegativeInt(baseEnv.DS_AGENT_MESH_QUEUE, DEFAULT_MESH_QUEUE)
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
    // T16 admission is deterministic and runs before mention/keyword. Ids only.
    const admission = admissionRulesFromEnv(baseEnv, opts.admission)
    log.info(`[runtime] instance=${instanceId} meshCapacity=${meshCapacity} meshQueue=${meshQueue} shards=${routerShards.list().length}`)
    log.info(`[runtime] model=${model.name}`)
    // An explicitly empty list disables that rule; do not log a misleading allowlist.
    if (admission.actors?.length || admission.groups?.length || admission.dropSelf?.length) {
      log.info(
        `[ingress] admission actors=${logList(admission.actors)} groups=${logList(admission.groups)} dropSelf=${logList(admission.dropSelf)}`,
      )
    }
    // Bound late because the host and the tool ports both reach the Harness.
    const late: { harness?: Harness } = {}
    /**
     * Engine.report runs inside `Store.atomic`; the Ticket document is written
     * just before the hook, but the Store snapshot only becomes observable to
     * other commands after commit. Releasing capacity synchronously would let
     * `Harness.pump` read the pre-report snapshot (Ticket open, Assignment
     * pending/running) and start a Worker for the Ticket that just ended.
     * A microtask runs after the synchronous transaction commits.
     */
    const releaseMesh = (ticketId: string): void => {
      queueMicrotask(() => {
        try {
          workerMesh.release(ticketId)
        } catch (error) {
          log.info(`[hook] hook=mesh-release ticketId=${ticketId} error=${error instanceof Error ? error.message : String(error)}`)
        }
        try {
          late.harness?.release(ticketId)
        } catch (error) {
          log.info(`[hook] hook=harness-release ticketId=${ticketId} error=${error instanceof Error ? error.message : String(error)}`)
        }
      })
    }
    const host: Host = {
      repo: store,
      now,
      metrics,
      log: line => log.info(line),
      scope: {
        // Admission is computed here every time. `trigger.meta` is untrusted and
        // never short-circuits the filter (docs/REVIEW.md C1).
        admit: trigger => {
          const verdict = filterTrigger(trigger, model, admission)
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
        // Capacity first, then let the scheduler start a queued Worker, but
        // only after the Engine transaction has committed the terminal state.
        releaseMesh(ticket.id)
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
      onAssignmentEnded: ticketId => {
        // blocked/failed/waiting end the Assignment but leave the Ticket open.
        // Free the logical Worker slot so enforcement does not leak capacity.
        releaseMesh(ticketId)
      },
      discardScratch: ticketId => env.discardIsolated?.(workerSessionId(ticketId)),
    }
    const engine = new Engine(host)
    const journal = new SessionJournal(path.join(opts.home, 'sessions'), store, line => log.info(line))
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
      assignmentPlaced: (ticketId, assignmentId, node) => {
        engine.assignmentPlaced(ticketId, assignmentId, node)
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
      queueLimit: meshQueue,
      releaseNode: ticketId => {
        workerMesh.release(ticketId)
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
      admission,
    })
    // Gate-deferred work goes to the Main Agent, not to an automatic accept.
    host.onAssessmentNeeded = () => runtime.assessPending()
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

  private assessments = new Set<Promise<void>>()
  private assessingThreads = new Set<string>()
  /**
   * A keyless serve process must not assess deferred human work with MockModel:
   * an invalid assessment commits `unavailable` and clears the thread queue.
   */
  private assessmentsEnabled = true

  private assessPending(): void {
    if (!this.assessmentsEnabled || !this.store.isOpen) return
    for (const thread of this.store.listDocs<Thread>('thread')) {
      if (!thread.deferred || !thread.pending.length || this.assessingThreads.has(thread.key)) continue
      this.assessingThreads.add(thread.key)
      const work = Promise.resolve().then(async () => {
        // The snapshot is taken when the queued Router turn starts, coalescing same-tick ingress.
        const current = this.store.getDoc<Thread>('thread', thread.key)
        const pending = [...(current?.pending ?? [])]
        if (!pending.length) return
        // Assessment is a second entrypoint to accept; ingress-denied triggers must
        // not survive in the queue. Clear them and persist even if others remain.
        const filtered = pending.filter(id => this.store.getDoc<Disposition>('disposition', id)?.filtered !== undefined)
        const ids = pending.filter(id => !filtered.includes(id))
        if (filtered.length) {
          const cleaned = this.store.getDoc<Thread>('thread', thread.key) ?? thread
          cleaned.pending = cleaned.pending.filter(id => !filtered.includes(id))
          if (!cleaned.pending.length) cleaned.deferred = false
          this.store.putDoc('thread', cleaned.key, cleaned)
          this.log.info(`[engine] assess.skip-filtered thread=${thread.key} triggerIds=${filtered.join(',')}`)
        }
        if (!ids.length) return
        const triggers = ids.map(id => this.store.getDoc<Trigger>('trigger', id))
          .filter((trigger): trigger is Trigger => trigger != null)
        const live = arbitrateSubscribers(this.store.listDocs<Ticket>('ticket').filter(ticket =>
          current!.subscriptions.includes(ticket.id) && !ticket.ended))
        const outcome = await assessWithMainAgent(this.model, triggers, live)
        if (!this.store.isOpen) return
        const decision = withSessionRole('router', () => this.engine.commitAssessed(thread.key, ids, outcome))
        if (decision?.kind === 'accept' && decision.ticketId) {
          const ticket = this.store.getDoc<Ticket>('ticket', decision.ticketId)
          if (ticket) this.harness.launch(ticket)
        }
      }).catch(error => {
        this.log.info(`[engine] Router assessment failed thread=${thread.key} error=${String(error)}`)
      }).finally(() => {
        this.assessingThreads.delete(thread.key)
        this.assessments.delete(work)
        if (this.store.isOpen) this.assessPending()
      })
      this.assessments.add(work)
    }
  }

  /**
   * Start the daemon timer. `assessPending: false` also disables every later
   * assessment path (including `onAssessmentNeeded` from flushEvals), so a
   * MockModel process leaves Gate-deferred work queued instead of consuming it.
   */
  start(options: { assessPending?: boolean } = {}): void {
    this.assessmentsEnabled = options.assessPending !== false
    this.recoverInterrupted()
    this.daemon.start()
    if (this.assessmentsEnabled) {
      // Resume Gate-deferred work left in SQLite by a previous process.
      this.assessPending()
    }
  }

  /**
   * ADR-004 restart recovery: persisted SQLite state is the source of truth.
   * The Engine owns every assignment/ticket transition; the Runtime only
   * orchestrates the launch. `MockModel` must not consume interrupted work, so
   * a keyless process records the deferral and leaves the state untouched.
   */
  private recoverInterrupted(): void {
    if (!this.store.isOpen) return
    if (this.model.name === 'MockModel') {
      this.log.info('[recovery] deferred reason=mock-model')
      return
    }
    let recovered: ReturnType<Engine['recoverInterrupted']>
    try {
      recovered = this.engine.recoverInterrupted()
    } catch (error) {
      this.log.info(`[recovery] failed error=${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const outcome of recovered) {
      const ticket = this.store.getDoc<Ticket>('ticket', outcome.ticketId)
      if (!ticket || ticket.ended) continue
      // The Engine committed the ended Assignment, the RECOVERED prompt, and
      // the single pending replacement before this launch.
      this.log.info(
        `[recovery] relaunch ticketId=${outcome.ticketId} interrupted=${outcome.interruptedAssignmentIds.join(',')} replacementId=${outcome.replacementAssignmentId}`,
      )
      void this.harness.launch(ticket)
    }
  }

  /** Wait until every in-flight Main Agent assessment has committed. */
  async assessmentsSettled(): Promise<void> {
    for (let wave = 0; wave < 40; wave += 1) {
      if (this.assessments.size === 0) return
      await Promise.allSettled([...this.assessments])
    }
    throw new Error('main-agent assessments did not settle')
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
    const verdict = filterTrigger(safe, this.model, this.admission)
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
      const disposition = this.store.getDoc<Disposition>('disposition', incoming.id)
      const reason = disposition?.filtered ?? `${verdict.layer}:${verdict.reason}`
      // Keep the historical keyword for actual noise; every other drop names its cause.
      if (reason === 'fast:noise' || reason === 'semantic:noise') this.log.info('noise dropped')
      else this.log.info(`[ingress] dropped reason=${reason}`)
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

  /** New Assignment on the same Ticket, then launch its Executor session. */
  async retry(ticketId: string, reason = 'retry'): Promise<Ticket | undefined> {
    this.engine.retryTicket(ticketId, reason)
    const ticket = this.store.getDoc<Ticket>('ticket', ticketId)
    if (ticket && !ticket.ended) await this.harness.launch(ticket)
    return ticket
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

  /** Wait for assessments and jobs, stop the daemon, and close SQLite. */
  async finish(): Promise<void> {
    let failure: unknown
    let failed = false
    const remember = (error: unknown): void => {
      // Preserve the first failure instead of masking a drain error with a
      // later metrics/close error.
      if (failed) return
      failed = true
      failure = error
    }
    try {
      await this.assessmentsSettled()
      this.flushEvals()
      await this.harness.jobsSettled()
    } catch (error) {
      remember(error)
    } finally {
      // The daemon timer and SQLite handle must be released even when a drain
      // step rejects; otherwise the process stays alive after a failed shutdown.
      this.daemon.stop()
      try {
        this.metrics.flush()
      } catch (error) {
        remember(error)
      } finally {
        // A failed metrics write must not leave SQLite open for other finish() callers.
        if (this.store.isOpen) {
          try {
            this.store.close()
          } catch (error) {
            remember(error)
          }
        }
      }
    }
    if (failed) throw failure
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
    // A2A has no authenticated human identity in this process, and this ingress
    // always produces a non-human Trigger. Peer authentication is external;
    // attributing a human identity through this path (or by bypassing `ingest`)
    // is not supported.
    human: false,
    addressed: 'direct',
    at,
    text,
    meta: {},
  }
}

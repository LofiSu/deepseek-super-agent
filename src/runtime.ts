import path from 'node:path'
import type {
  CollaborationView,
  DecideApprovalOutcome,
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
import { loadRoutines, normalizeRoutines, RoutineScheduler, type RoutineSpec } from './harness/routines.ts'
import { MachineRegistry } from './harness/machines.ts'
import { McpToolSource } from './harness/mcp.ts'
import { parseMcpServers, type McpServerConfig } from './harness/mcp-config.ts'
import { TeamRegistry } from './harness/team.ts'
import { createModelFromEnv, HttpOpenAI, roleModelsFromEnv, type Model } from './harness/model.ts'
import { directChatRouterShard, directChatThread, SessionJournal, sharesDirectChatThread, workerSessionId } from './harness/session.ts'
import { loadPromptFiles, type PromptFiles } from './harness/prompts.ts'
import { LocalAgentRegistry, loadLocalAgents, type LocalAgentSpec } from './env/local-agents.ts'
import { SkillRegistry } from './env/skills.ts'
import { ToolRegistry } from './harness/tools.ts'
import { filterTrigger, type AdmissionRules, type FilterVerdict } from './ingress/filter.ts'
import {
  DEFAULT_POLICY_TIMEOUT_MS,
  filterTriggerWithPolicy,
  isSemanticPolicy,
  PolicyClassifier,
  type SemanticPolicy,
} from './ingress/policy.ts'
import { RouterShardRegistry, type RouterShard } from './ingress/shards.ts'
import { inlineOrSpill } from './memory/recall.ts'
import { DEFAULT_EMBEDDING_FLOOR, HashedEmbedding, type EmbeddingPort } from './memory/embedding.ts'
import { refsForTrigger, triggerRef } from './memory/graph.ts'
import { SpillBackedLongTermMemory } from './memory/long-term.ts'
import { Metrics } from './metrics/metrics.ts'
import { A2ARouter, type A2ADelivery, type A2AEnvelope } from './channels/a2a.ts'
import { LifecycleBus } from './core/lifecycle.ts'
import { WorkerMeshRegistry } from './harness/mesh.ts'
import { WorkerPlacement } from './harness/mesh-runtime.ts'
import {
  RemoteMeshResultWait,
  remoteResultTimeoutMsFromEnv,
} from './harness/remote-mesh-wait.ts'
import { recordRemoteResult } from './harness/remote-results.ts'
import type { RemoteMeshAssignmentResultEvent } from './harness/remote-node.ts'
import type { WorkerReport } from './shared/ports.ts'
import { Logger } from './shared/log.ts'
import { threadKey, type Disposition, type ObjectRef, type ReceiveResult, type Thread, type Ticket, type Trigger, type TriggerTrust } from './shared/types.ts'
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
  /**
   * External MCP servers (array or JSON array string). Overrides
   * `DS_AGENT_MCP_SERVERS`. Their tools are exposed to Workers only.
   */
  mcpServers?: unknown
  /**
   * Owner-editable persona, standing instructions, and owner context. Defaults
   * to PERSONA.md / AGENTS.md / USER.md in `home`, then DS_AGENT_* seeds.
   */
  prompts?: PromptFiles
  /**
   * Local specialist agents Workers may delegate to. Defaults to
   * `local-agents.json` in `home`, then `DS_AGENT_LOCAL_AGENTS`.
   */
  localAgents?: LocalAgentSpec[]
  /** Owner-authored playbooks. Defaults to `skills/<id>/SKILL.md` in `home`. */
  skills?: SkillRegistry
  /**
   * Owner-defined recurring routines. Defaults to `routines.json` in `home`,
   * then `DS_AGENT_ROUTINES`.
   */
  routines?: RoutineSpec[]
  /** Local A2A address and mesh node id. Defaults to `DS_AGENT_INSTANCE_ID` or `local`. */
  instanceId?: string
  /** Worker slots this process advertises. Defaults to `DS_AGENT_MESH_CAPACITY` or 4. */
  meshCapacity?: number
  /**
   * Workers allowed to wait for a mesh slot. Defaults to `DS_AGENT_MESH_QUEUE`
   * or 100. `0` rejects instead of queueing.
   */
  meshQueue?: number
  /**
   * Max wait for remote `assignment_result` after dispatch is delivered.
   * Overrides `DS_AGENT_REMOTE_RESULT_TIMEOUT_MS`.
   */
  remoteResultTimeoutMs?: number
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
   * Opt-in model Slow Path (T17). Default is deterministic rules; `model` makes
   * `ingestAsync` consult an injected policy or a model implementing
   * `classifyPolicy`. Sync `ingest` always stays on rules.
   */
  slowPath?: SlowPathOptions
  /**
   * Long-term memory retention. Overrides `DS_AGENT_MEMORY_MAX_ENTRIES` /
   * `DS_AGENT_MEMORY_MAX_AGE_DAYS`; 0 disables that dimension.
   */
  memoryRetention?: MemoryRetention
  /**
   * Optional semantic recall port. Defaults to the offline `HashedEmbedding`;
   * `false` (or `DS_AGENT_SEMANTIC_RECALL=0`) keeps recall lexical-only.
   * A configured port never makes a network or model call by itself.
   */
  embeddings?: EmbeddingPort | false
  /**
   * Cosine floor for a semantic-only hit. Overrides
   * `DS_AGENT_EMBEDDING_FLOOR`; defaults to 0.35 and is clamped to 0..1.
   */
  embeddingFloor?: number
  /**
   * Bounded in-memory lifecycle history and the restart-replay cap.
   * Defaults to 1000 and keeps the newest events.
   */
  lifecycleMaxEvents?: number
  /**
   * Durable lifecycle-log retention. Defaults to `lifecycleMaxEvents`; larger
   * values keep a longer audit history, while smaller values are raised to the
   * in-memory cap so restart replay can always refill the ring. The oldest
   * rows are pruned on startup and after every append.
   */
  lifecycleRetention?: number
}

export interface MemoryRetention {
  maxEntries?: number
  maxAgeDays?: number
  /** Cold thread digests that survive hot-entry pruning (§8.1). */
  coldMaxEntries?: number
  coldMaxAgeDays?: number
}

export interface SlowPathOptions {
  /** `rules` (default) keeps deterministic ingress; `model` opts into the policy. */
  mode?: 'rules' | 'model'
  /** Hard bound per policy call. Valid range is 100..30000 ms. */
  timeoutMs?: number
  /** Injected policy; otherwise a model implementing `classifyPolicy` is used. */
  policy?: SemanticPolicy
}

export type SlowPathMode = 'rules' | 'model'

/** Lower/upper bound for `DS_AGENT_SLOW_PATH_TIMEOUT_MS`; outside is invalid. */
export const MIN_SLOW_PATH_TIMEOUT_MS = 100
export const MAX_SLOW_PATH_TIMEOUT_MS = 30_000

interface ResolvedSlowPath {
  mode: SlowPathMode
  timeoutMs: number
  classifier?: PolicyClassifier
}

/**
 * Resolve the opt-in Slow Path. Fail closed: an unknown mode, an out-of-range
 * timeout, or `model` without a policy-capable model all fall back to rules
 * with one reason-only log line (config values are never echoed).
 */
function resolveSlowPath(
  env: NodeJS.ProcessEnv,
  override: SlowPathOptions | undefined,
  model: Model,
  log: Logger,
): ResolvedSlowPath {
  const configuredMode = override?.mode ?? env.DS_AGENT_SLOW_PATH?.trim()
  let mode: SlowPathMode = 'rules'
  if (configuredMode === 'rules') {
    mode = 'rules'
  } else if (configuredMode === 'model') {
    mode = 'model'
  } else if (configuredMode) {
    log.info('[ingress] slow-path ignored reason=invalid-mode using=rules')
  }
  if (mode === 'rules') {
    return { mode, timeoutMs: DEFAULT_POLICY_TIMEOUT_MS }
  }

  const rawTimeout = override?.timeoutMs ?? env.DS_AGENT_SLOW_PATH_TIMEOUT_MS?.trim()
  let timeoutMs = DEFAULT_POLICY_TIMEOUT_MS
  if (rawTimeout !== undefined && rawTimeout !== '') {
    const parsed = typeof rawTimeout === 'number' ? rawTimeout : Number(rawTimeout)
    if (
      !Number.isFinite(parsed)
      || !Number.isInteger(parsed)
      || parsed < MIN_SLOW_PATH_TIMEOUT_MS
      || parsed > MAX_SLOW_PATH_TIMEOUT_MS
    ) {
      log.info('[ingress] slow-path ignored reason=invalid-timeout using=rules')
      return { mode: 'rules', timeoutMs: DEFAULT_POLICY_TIMEOUT_MS }
    }
    timeoutMs = parsed
  }

  const policy = override?.policy ?? (isSemanticPolicy(model) ? model : undefined)
  if (!policy) {
    log.info('[ingress] slow-path model unavailable using=rules')
    return { mode: 'rules', timeoutMs: DEFAULT_POLICY_TIMEOUT_MS }
  }
  // The HTTP implementation carries its own abort bound; keep it aligned with
  // the configured budget so the outer classifier race is not the only limit.
  if (policy instanceof HttpOpenAI) policy.setPolicyTimeout(timeoutMs)
  return { mode, timeoutMs, classifier: new PolicyClassifier(policy, timeoutMs) }
}

/** Conservative defaults: bound index growth without dropping recent history. */
export const DEFAULT_MEMORY_MAX_ENTRIES = 1000
export const DEFAULT_MEMORY_MAX_AGE_DAYS = 90
/** Cold digests are small and intentionally month-scale. */
export const DEFAULT_MEMORY_COLD_MAX_ENTRIES = 200
export const DEFAULT_MEMORY_COLD_MAX_AGE_DAYS = 3650
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
    coldMaxEntries: override.coldMaxEntries
      ?? parseNonNegativeInt(env.DS_AGENT_MEMORY_COLD_MAX_ENTRIES, DEFAULT_MEMORY_COLD_MAX_ENTRIES),
    coldMaxAgeDays: override.coldMaxAgeDays
      ?? parseNonNegativeInt(env.DS_AGENT_MEMORY_COLD_MAX_AGE_DAYS, DEFAULT_MEMORY_COLD_MAX_AGE_DAYS),
  }
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

/**
 * Semantic recall is on unless explicitly disabled. An explicit
 * `RuntimeOptions.embeddings` wins over the environment, including an explicit
 * provider next to a stale kill switch.
 */
export function semanticRecallEnabled(
  env: NodeJS.ProcessEnv,
  override?: EmbeddingPort | false,
): boolean {
  if (override !== undefined) return override !== false
  const value = env.DS_AGENT_SEMANTIC_RECALL?.trim().toLowerCase()
  return !(value === '' || value === '0' || value === 'false' || value === 'off' || value === 'no')
}

/** `DS_AGENT_EMBEDDING_FLOOR` in [0,1]; invalid values use the default. */
export function embeddingFloorFromEnv(
  env: NodeJS.ProcessEnv,
  override?: number,
): number {
  const raw = override ?? (env.DS_AGENT_EMBEDDING_FLOOR?.trim() || undefined)
  const value = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_EMBEDDING_FLOOR
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
  /** Owner-configured local specialist agents; absent means delegation is off. */
  readonly localAgents?: LocalAgentRegistry
  /** Owner-authored playbooks; also used by the read_skill tool. */
  readonly skills?: SkillRegistry
  /** Owner-defined routines, due-checked by the daemon tick. */
  readonly routines?: RoutineScheduler
  /** Local A2A address and Worker mesh node id. */
  readonly instanceId: string
  readonly routerShards: RouterShardRegistry
  readonly workerMesh: WorkerMeshRegistry
  /** Local + optional remote mesh placement (T47 runtime path). */
  readonly placement: WorkerPlacement
  readonly longTermMemory: SpillBackedLongTermMemory
  /** Read-model lifecycle events for panels and CLI views. */
  readonly lifecycle: LifecycleBus
  readonly a2aRouter: A2ARouter
  /** Effective Slow Path mode after env/config validation. Defaults to `rules`. */
  readonly slowPathMode: SlowPathMode
  /** Classifier used by `ingestAsync`; absent in rules mode. */
  readonly slowPathPolicy?: PolicyClassifier

  private readonly redact: (text: string) => string
  private readonly batchWindowMs: number
  private readonly admission: AdmissionRules
  /** Kept so finish() can close external MCP server processes. */
  private readonly tools: ToolRegistry
  private readonly remoteResultWait?: RemoteMeshResultWait
  private evalTimer: ReturnType<typeof setTimeout> | undefined
  /** Recovery scans persisted state once per Runtime; a restart builds a new one. */
  private recoveryAttempted = false

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
    localAgents?: LocalAgentRegistry
    skills?: SkillRegistry
    routines?: RoutineScheduler
    instanceId: string
    routerShards: RouterShardRegistry
    workerMesh: WorkerMeshRegistry
    placement: WorkerPlacement
    longTermMemory: SpillBackedLongTermMemory
    lifecycle: LifecycleBus
    a2aRouter: A2ARouter
    slowPathMode: SlowPathMode
    slowPathPolicy?: PolicyClassifier
    redact: (text: string) => string
    batchWindowMs: number
    admission: AdmissionRules
    tools: ToolRegistry
    remoteResultWait?: RemoteMeshResultWait
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
    this.localAgents = parts.localAgents
    this.skills = parts.skills
    this.routines = parts.routines
    this.instanceId = parts.instanceId
    this.routerShards = parts.routerShards
    this.workerMesh = parts.workerMesh
    this.placement = parts.placement
    this.longTermMemory = parts.longTermMemory
    this.lifecycle = parts.lifecycle
    this.a2aRouter = parts.a2aRouter
    this.slowPathMode = parts.slowPathMode
    this.slowPathPolicy = parts.slowPathPolicy
    this.redact = parts.redact
    this.batchWindowMs = parts.batchWindowMs
    this.admission = parts.admission
    this.tools = parts.tools
    this.remoteResultWait = parts.remoteResultWait
  }

  static create(opts: RuntimeOptions): Runtime {
    const baseEnv = opts.env ?? process.env
    const mcpConfig = mcpServersFromConfig(opts.mcpServers, baseEnv)
    // A server's own env is where its credentials live, so its secret-named
    // values join the redaction list before anything logs or persists.
    const secrets = [...new Set([
      ...secretValues(baseEnv),
      ...mcpConfig.configs.flatMap(config => secretValues(config.env)),
    ])].sort((a, b) => b.length - a.length)
    const redact = (text: string) => redactSecrets(text, secrets)
    const log = new RedactingLogger(redact)
    if (mcpConfig.error) log.info(`[mcp] DS_AGENT_MCP_SERVERS ignored: ${mcpConfig.error}`)
    const model = opts.model ?? createModelFromEnv(baseEnv)
    const models = { ...roleModelsFromEnv(baseEnv, model), ...(opts.models ?? {}) }
    const store = new Store(opts.home)
    const metrics = new Metrics(opts.home)
    const env = new LocalEnv(path.join(opts.home, 'workspaces'), { env: baseEnv })
    const now = opts.now ?? (() => new Date().toISOString())
    const promptFiles = opts.prompts ?? loadPromptFiles(opts.home, baseEnv)
    const localAgentSpecs = opts.localAgents ?? loadLocalAgents(opts.home, baseEnv)
    const localAgents = localAgentSpecs.length
      ? new LocalAgentRegistry(localAgentSpecs, {
        env: baseEnv,
        workspace: workerId => env.workspace(workerId),
      })
      : undefined
    if (localAgents) {
      log.info(`[local-agent] configured agents=${localAgents.list().map(agent => agent.id).join(',')}`)
    }
    const skills = opts.skills ?? SkillRegistry.fromHome(opts.home, line => log.info(line))
    if (skills.size) {
      log.info(`[skill] configured skills=${skills.list().map(skill => skill.id).join(',')}`)
    }

    // The scheduler is built before the Runtime exists; the closure forwards
    // into Runtime.ingest once construction finishes, so routines take the
    // normal filter, spill, dedupe, and Engine path.
    let fireRoutine: (trigger: Trigger) => void = () => {}
    // Programmatic specs follow the same bounds as file/env specs; skipping
    // normalization lets everyMinutes=0 create a fire-on-every-tick loop.
    const routineSpecs = opts.routines === undefined
      ? loadRoutines(opts.home, baseEnv)
      : normalizeRoutines(opts.routines)
    const routines = routineSpecs.length
      ? new RoutineScheduler(routineSpecs, {
        now: () => Date.parse(now()),
        lastRun: id => store.getDoc<{ lastRunAt?: number }>('routine', id)?.lastRunAt,
        saveLastRun: (id, at) => store.putDoc('routine', id, {
          id,
          lastRunAt: at,
          updatedAt: new Date(at).toISOString(),
        }),
        fire: trigger => fireRoutine(trigger),
        log: line => log.info(line),
      })
      : undefined
    if (routines) {
      log.info(`[routine] configured routines=${routines.list().map(routine => routine.id).join(',')}`)
    }
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
    const placement = WorkerPlacement.fromEnv(baseEnv, instanceId, workerMesh, line => log.info(line))
    // Retention keeps the durable index bounded: 1000 entries / 90 days by
    // default, with 0 disabling either dimension.
    const retention = memoryRetentionFromEnv(baseEnv, opts.memoryRetention)
    const embeddings = semanticRecallEnabled(baseEnv, opts.embeddings)
      ? opts.embeddings || new HashedEmbedding()
      : undefined
    const longTermMemory = new SpillBackedLongTermMemory(store, redact, {
      ...retention,
      ...(embeddings ? {
        embedding: embeddings,
        embeddingFloor: embeddingFloorFromEnv(baseEnv, opts.embeddingFloor),
      } : {}),
    })
    const lifecycle = new LifecycleBus(opts.lifecycleMaxEvents)
    const lifecycleRetention = lifecycleRetentionFor(opts.lifecycleRetention, lifecycle.maxEvents)
    // Restart replay: first bound any existing durable log, then fill the ring
    // from the newest persisted events before this Runtime publishes anything
    // new. A broken sink leaves the in-memory bus fully usable and is
    // reported once by the bus.
    try {
      store.pruneLifecycleEvents(lifecycleRetention)
    } catch (error) {
      log.info(`[lifecycle] retention prune failed; continuing: ${error instanceof Error ? error.message : String(error)}`)
    }
    lifecycle.attachSink({
      // Lifecycle payloads are existing metadata only; the Store writes the
      // event as given plus a write-time `at`. Retention keeps the table
      // bounded after every append.
      append: event => store.appendLifecycleEvent(event, lifecycleRetention),
      recent: limit => store.recentLifecycleEvents(limit),
    }, (error, operation) => {
      log.info(`[lifecycle] persistence ${operation} failed; continuing in memory: ${error instanceof Error ? error.message : String(error)}`)
    })
    lifecycle.hydrateFromSink()
    const a2aRouter = new A2ARouter(store)
    // T16 admission is deterministic and runs before mention/keyword. Ids only.
    const admission = admissionRulesFromEnv(baseEnv, opts.admission)
    // T17 Slow Path: rules by default. Model mode is explicit and fail-closed.
    const slowPath = resolveSlowPath(baseEnv, opts.slowPath, model, log)
    log.info(`[runtime] instance=${instanceId} meshCapacity=${meshCapacity} meshQueue=${meshQueue} shards=${routerShards.list().length}`)
    log.info(`[runtime] model=${model.name}`)
    log.info(
      `[ingress] slow-path mode=${slowPath.mode} timeoutMs=${slowPath.timeoutMs}`
      + (slowPath.classifier ? ` policy=${slowPath.classifier.name}` : ''),
    )
    if (slowPath.mode === 'model') {
      // Sync ingest is intentionally unchanged; call this out so an operator
      // does not believe the model policy applies to A2A or legacy callers.
      log.info('[ingress] slow-path sync ingest uses rules; only ingestAsync applies the policy')
    }
    // An explicitly empty list disables that rule; do not log a misleading allowlist.
    if (admission.actors?.length || admission.groups?.length || admission.dropSelf?.length) {
      log.info(
        `[ingress] admission actors=${logList(admission.actors)} groups=${logList(admission.groups)} dropSelf=${logList(admission.dropSelf)}`,
      )
    }
    // Bound late because the host and the tool ports both reach the Harness.
    const late: { harness?: Harness; remoteResultWait?: RemoteMeshResultWait } = {}
    const remoteResultTimeoutMs = remoteResultTimeoutMsFromEnv(baseEnv, opts.remoteResultTimeoutMs)
    late.remoteResultWait = new RemoteMeshResultWait(remoteResultTimeoutMs, (ticketId, assignmentId) => {
      log.info(
        `[mesh] remote result timeout ticketId=${ticketId} assignmentId=${assignmentId} timeoutMs=${remoteResultTimeoutMs}`,
      )
      try {
        engine.report(ticketId, {
          kind: 'failed',
          text: 'remote worker result timeout',
          deliver: false,
        })
      } catch (error) {
        log.info(
          `[mesh] remote timeout report failed ticketId=${ticketId} error=${error instanceof Error ? error.message : String(error)}`,
        )
        placement.release(ticketId)
      }
    })
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
          placement.release(ticketId)
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
        const shards = store.getDoc<Disposition>('disposition', ticket.originTriggerId)?.shards ?? ['default']
        for (const shard of shards) {
          late.harness?.routerObserve(shard, {
            kind: 'ticket.created',
            ticketId: ticket.id,
            title: ticket.title,
            threads: ticket.threadKeys,
            speculative: ticket.speculative,
          })
        }
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
        const shards = store.getDoc<Disposition>('disposition', ticket.originTriggerId)?.shards ?? ['default']
        for (const shard of shards) {
          late.harness?.routerObserve(shard, {
            kind: 'ticket.ended',
            ticketId: ticket.id,
            outcome: ticket.ended?.outcome ?? 'unknown',
            by: ticket.ended?.by ?? 'unknown',
            memoryId: entry.id,
          })
        }
        metrics.increment('memory.remembered')
        log.info(`[memory] ticket.ended ticketId=${ticket.id} memory=${entry.id}`)
      },
      onDecision: decision => {
        // Router global memory (§2.1): decisions survive Tickets and channels.
        const entry = longTermMemory.rememberDecision(decision)
        lifecycle.publish({
          kind: 'decision.remembered',
          payload: { decisionId: decision.id, kind: decision.kind, memoryId: entry.id },
        })
        late.harness?.routerObserve('default', {
          kind: 'decision',
          decisionId: decision.id,
          action: decision.kind,
          thread: decision.threadKey,
          ticketId: decision.ticketId,
          triggerIds: decision.triggerIds,
        })
        metrics.increment('memory.decision')
        log.info(`[memory] decision.remembered decisionId=${decision.id} memory=${entry.id}`)
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
    const mcpConfigs = mcpConfig.configs
    const mcp = mcpConfigs.length === 0
      ? undefined
      : new McpToolSource(mcpConfigs, {
        log: line => log.info(line),
        metrics,
        redact,
        spill: { put: body => store.putSpill(body) },
        workspaceDir: path.join(opts.home, 'mcp'),
        baseEnv,
      })
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
      ...(mcp ? { mcp } : {}),
      localAgents,
      ...(skills.size ? { skills } : {}),
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
      prompts: promptFiles,
      ...(localAgents ? { localAgents: localAgents.list() } : {}),
      ...(skills.size ? { skills: skills.list() } : {}),
      teams,
      takeGuidance: (ticketId, audience) => engine.takeGuidance(ticketId, audience),
      singleSession: opts.singleSession === true,
      routerSessions: ticket => {
        // One Router session per direct iMessage thread: two conversations at
        // once must not share history or bleed into each other's replies.
        const direct = directChatRouterShard(ticket)
        if (direct) return [direct]
        const disposition = store.getDoc<Disposition>('disposition', ticket.originTriggerId)
        return disposition?.shards?.length ? disposition.shards : ['default']
      },
      pickNode: ticketId => {
        const nodeId = placement.pickNode(ticketId)
        if (nodeId) metrics.increment('mesh.assigned')
        return nodeId
      },
      isRemoteNode: nodeId => placement.isRemote(nodeId),
      dispatchRemote: async (ticket, node) => {
        const assignment = ticket.assignments.at(-1)
        if (!assignment) return
        const payload = {
          assignmentId: assignment.id,
          ticketId: ticket.id,
          title: ticket.title,
          brief: ticket.brief,
          mandate: ticket.mandate,
        }
        const delivery = await placement.dispatch(ticket.id, payload)
        if (delivery?.status !== 'delivered') {
          log.info(`[mesh] remote dispatch failed ticketId=${ticket.id} node=${node} status=${delivery?.status ?? 'none'}`)
          placement.release(ticket.id)
          late.remoteResultWait?.clear(ticket.id)
          return
        }
        late.remoteResultWait?.arm(ticket.id, assignment.id)
      },
      queueLimit: meshQueue,
      releaseNode: ticketId => {
        placement.release(ticketId)
      },
      repliedTo: ticketId => store.listReplies().some(
        reply => reply.ticketId === ticketId && reply.channel === 'imessage',
      ),
      stopAnsweredDirectChat: (ticket, reason) => {
        engine.decide(ticket.originTriggerId, { kind: 'stop', ticketId: ticket.id, reason })
      },
      memory: ticket => {
        // Direct chats are private threads: recall only memories that belong to
        // the same conversation. Cross-ticket recall stays for repository work.
        const thread = directChatThread(ticket)
        const lexical = longTermMemory.query({
          ticketId: ticket.id,
          text: ticket.title,
          limit: thread ? 50 : 3,
        })
        const scoped = thread
          ? lexical.filter(entry => {
            const source = store.getDoc<Ticket>('ticket', entry.ticketId)
            return source ? sharesDirectChatThread(source, thread) : false
          }).slice(0, 3)
          : lexical
        // Same-Thread decisions and cold digests are injected even when the
        // new title shares no lexical token.
        const threaded = longTermMemory.forThreads(ticket.threadKeys, 3, ticket.id)
        const seen = new Set<string>()
        const entries = [...threaded, ...scoped].filter(entry => {
          if (seen.has(entry.id)) return false
          seen.add(entry.id)
          return true
        }).slice(0, 5)
        if (entries.length) metrics.increment('memory.recalled', entries.length)
        return entries.map(entry => ({
          id: entry.id,
          spillId: entry.spillId,
          text: entry.text,
          refs: entry.refs ?? [],
        }))
      },
      routerMemory: ticket => {
        // A direct chat must never inherit another conversation's decisions:
        // global decision recall is for repository work, not a private thread.
        const direct = directChatThread(ticket) !== undefined
        const seen = new Set<string>()
        return [
          ...(direct ? [] : [longTermMemory.recentDecisions(3, ticket.id)]),
          ...longTermMemory.forThreads(ticket.threadKeys, 3, ticket.id),
        ].flat().filter(entry => {
          if (seen.has(entry.id)) return false
          seen.add(entry.id)
          return true
        }).slice(0, 5).map(entry => ({
          id: entry.id,
          spillId: entry.spillId,
          text: entry.text,
          refs: entry.refs ?? [],
        }))
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
    const daemon = new Daemon(watchdog, line => log.info(line), machines, undefined, routines)
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
      ...(localAgents ? { localAgents } : {}),
      skills,
      ...(routines ? { routines } : {}),
      instanceId,
      routerShards,
      workerMesh,
      placement,
      longTermMemory,
      lifecycle,
      a2aRouter,
      slowPathMode: slowPath.mode,
      ...(slowPath.classifier ? { slowPathPolicy: slowPath.classifier } : {}),
      redact,
      batchWindowMs: opts.batchWindowMs ?? 0,
      admission,
      tools,
      remoteResultWait: late.remoteResultWait,
    })
    // Gate-deferred work goes to the Main Agent, not to an automatic accept.
    fireRoutine = trigger => runtime.ingest(trigger)
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
      // A2A inbound stays synchronous and rules-only in this change (ADR-011);
      // remote peers do not get the opt-in model Slow Path until it is audited.
      runtime.ingest(trigger)
    })
    return runtime
  }

  /**
   * Apply an authenticated inbound mesh worker result. Idempotent on
   * `deliveryKey`. Does not start a listener; operators mount
   * `createRemoteMeshHandler` themselves.
   */
  applyRemoteAssignmentResult(event: RemoteMeshAssignmentResultEvent): void {
    if (!this.store.isOpen) return
    const report = event.report as WorkerReport
    if (typeof report?.kind !== 'string' || typeof report?.text !== 'string') {
      this.log.info(`[mesh] remote result ignored ticketId=${event.ticketId} reason=bad-report`)
      return
    }
    const applied = recordRemoteResult(this.store, {
      ticketId: event.ticketId,
      assignmentId: event.assignmentId,
      report,
      deliveryKey: event.deliveryKey,
    })
    if (!applied) {
      this.log.info(`[mesh] remote result duplicate deliveryKey=${event.deliveryKey}`)
      return
    }
    this.remoteResultWait?.clear(event.ticketId)
    try {
      this.engine.report(event.ticketId, report)
    } finally {
      this.placement.release(event.ticketId)
    }
    this.log.info(`[mesh] remote result applied ticketId=${event.ticketId} assignmentId=${event.assignmentId}`)
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
      // A deferred assessment belongs to the shard that routed its triggers.
      // Running it on `default` would read the wrong resident history and
      // journal the outcome where that Router never sees it.
      const shard = this.assessmentShard(thread.pending)
      const work = this.harness.routerExclusive(shard, async () => {
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
        const seen = new Set<string>()
        const memory = [
          ...this.longTermMemory.recentDecisions(3, live?.id),
          ...this.longTermMemory.forThreads([thread.key], 3, live?.id),
        ].filter(entry => {
          if (seen.has(entry.id)) return false
          seen.add(entry.id)
          return true
        }).map(entry => ({
          id: entry.id,
          text: entry.text,
          refs: entry.refs ?? [],
        }))
        const history = this.harness.routerHistory(shard, 12)
        const outcome = await assessWithMainAgent(this.model, triggers, live, 'policy-v1', memory, history)
        if (!this.store.isOpen) return
        const decision = withSessionRole('router', () => this.engine.commitAssessed(thread.key, ids, outcome))
        this.harness.routerObserve(shard, {
          kind: 'assessment',
          thread: thread.key,
          action: outcome.kind,
          triggerIds: ids,
          ticketId: decision?.ticketId,
        })
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

  /** The first shard that routed any queued trigger; `default` when none did. */
  private assessmentShard(triggerIds: readonly string[]): string {
    for (const id of triggerIds) {
      const shard = this.store.getDoc<Disposition>('disposition', id)?.shards?.[0]
      if (shard) return shard
    }
    return 'default'
  }

  /**
   * Start the daemon timer. `assessPending: false` also disables every later
   * assessment path (including `onAssessmentNeeded` from flushEvals), so a
   * MockModel process leaves Gate-deferred work queued instead of consuming it.
   * `routines: true` is only for long-lived serving processes: a one-shot CLI
   * command must not fire owner-level work whose channel loop is not running.
   */
  start(options: { assessPending?: boolean; routines?: boolean } = {}): void {
    this.assessmentsEnabled = options.assessPending !== false
    // The Router layer is resident: every configured shard gets its Session
    // before recovery, assessment, or the first Trigger.
    this.armResidentRouters()
    this.recoverInterrupted()
    this.daemon.start({ routines: options.routines === true })
    if (this.assessmentsEnabled) {
      // Resume Gate-deferred work left in SQLite by a previous process.
      this.assessPending()
    }
  }

  private armResidentRouters(): void {
    for (const shard of this.routerShards.list()) this.harness.armRouter(shard.id)
  }

  /**
   * ADR-004 restart recovery: persisted SQLite state is the source of truth.
   * The Engine owns every assignment/ticket transition; the Runtime only
   * orchestrates the launch. `MockModel` must not consume interrupted work, so
   * a keyless process records the deferral and leaves the state untouched.
   */
  private recoverInterrupted(): void {
    if (!this.store.isOpen || this.recoveryAttempted) return
    // One scan per Runtime. A real restart constructs a new Runtime, so it
    // still recovers; repeated start() calls must not end a live replacement
    // that our own asynchronous launch has already marked `running`.
    this.recoveryAttempted = true
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
        `[recovery] relaunch ticketId=${outcome.ticketId} interrupted=${outcome.interruptedAssignmentIds.join(',') || '-'} replacementId=${outcome.replacementAssignmentId} mode=${outcome.relaunchOnly ? 'pending' : 'recovered'}`,
      )
      this.launchRecovered(outcome.ticketId, ticket)
    }
  }

  /**
   * Relaunch one recovered Ticket without letting a failure abort the others
   * or surface as an unhandled rejection. A launch failure changes no state:
   * the replacement stays `pending`, so a later restart can relaunch it.
   */
  private launchRecovered(ticketId: string, ticket: Ticket): void {
    const failed = (error: unknown): void => {
      this.log.info(
        `[recovery] launch failed ticketId=${ticketId} error=${error instanceof Error ? error.message : String(error)}`,
      )
    }
    try {
      void this.harness.launch(ticket).catch(failed)
    } catch (error) {
      failed(error)
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
   * Synchronous ingress. Always rules-only: existing callers (A2A inbound,
   * demos, tests, gate-adjacent paths) keep their behavior. Use
   * `ingestAsync` where the opt-in model Slow Path is desired.
   */
  ingest(trigger: Trigger): ReceiveResult {
    const duplicate = this.duplicate(trigger)
    if (duplicate) return duplicate
    const safe: Trigger = { ...trigger, text: this.redact(trigger.text) }
    return this.commitIngress(safe, filterTrigger(safe, this.model, this.admission))
  }

  /**
   * Ingress with the configured Slow Path. In rules mode this is exactly the
   * sync path; in model mode it awaits the policy (which never rejects and
   * falls back to `ruleClassify` on timeout, throw, or invalid output).
   */
  async ingestAsync(trigger: Trigger): Promise<ReceiveResult> {
    const duplicate = this.duplicate(trigger)
    if (duplicate) return duplicate
    const safe: Trigger = { ...trigger, text: this.redact(trigger.text) }
    const verdict = this.slowPathPolicy
      ? await filterTriggerWithPolicy(safe, this.model, this.admission, this.slowPathPolicy)
      : filterTrigger(safe, this.model, this.admission)
    // Re-check after the await: a concurrent call for the same id may have
    // committed while this one was waiting on the policy. Without this, the
    // loser would still spill a body, emit metrics/log lines, and only then
    // learn from Engine.receive that it was a duplicate.
    const raced = this.duplicate(trigger)
    if (raced) return raced
    return this.commitIngress(safe, verdict)
  }

  /** A persisted trigger id is a duplicate; re-receive so the Engine stays authoritative. */
  private duplicate(trigger: Trigger): ReceiveResult | undefined {
    if (!this.store.getDoc<Trigger>('trigger', trigger.id)) return undefined
    const result = this.engine.receive(trigger)
    this.log.info(`[engine] Intake.receive id=${trigger.id} result=${result}`)
    return result
  }

  /**
   * Shared post-verdict path for sync and async ingress: metrics/log, the
   * admission sidecar, inline/spill, shards, Engine.receive, filtered/disposition
   * logging, fan-out delivery, and Eval scheduling.
   */
  private commitIngress(safe: Trigger, verdict: FilterVerdict): ReceiveResult {
    if (verdict.action === 'pass') this.metrics.increment('ingress.admit')
    else this.metrics.increment('ingress.drop')
    this.log.info(
      `[ingress] two-level fast=${verdict.fast} semantic=${verdict.semantic} model=${this.model.name} action=${verdict.action} layer=${verdict.layer}`,
    )
    // The Runtime already classified this trigger (possibly with the model
    // policy). Pin that verdict so Intake cannot re-run rules and undo a model
    // drop or a model-only pass.
    const admission = verdict.action === 'pass'
      ? { listened: true, reason: verdict.reason }
      : { listened: false, reason: `${verdict.layer}:${verdict.reason}` }
    let incoming: Trigger = { ...safe, meta: {} }
    let trust: TriggerTrust = { admission }
    if (verdict.action === 'pass') {
      const neighbors = this.neighborTriggerRefs(safe)
      let triggerRefs = refsForTrigger(safe, undefined, neighbors)
      const recall = inlineOrSpill(
        safe.text,
        (body, refs) => this.store.putSpill(body, refs),
        triggerRefs,
      )
      if (recall.spillId) {
        // The handle must carry its own spill id, otherwise read_object can only
        // return the inline summary and the full trigger body is unreachable.
        triggerRefs = refsForTrigger(safe, recall.spillId, neighbors)
        this.store.replaceSpill(recall.spillId, safe.text, triggerRefs)
        this.log.info(`[memory] Inline/Spill chain-of-recall spillId=${recall.spillId} bytes=${recall.bytes}`)
      }
      // A channel hint may only ask for silence (speculate). It cannot buy admission.
      const shards = this.routerShards.route(safe)
      this.metrics.increment('router.shard', shards.length)
      this.log.info(`[routing] shards=${shards.join(',')} triggerId=${safe.id}`)
      trust = {
        admission,
        spillId: recall.spillId,
        refs: triggerRefs,
        strength: safe.speculate === true ? 'maybe' : verdict.strength,
        filterText: safe.text,
        shards,
      }
      incoming = { ...safe, text: recall.inline, meta: {}, refs: triggerRefs }
    }
    const result = this.engine.receive(incoming, trust)
    this.observeIngress(incoming, verdict, trust, result)
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
   * Feed the resident Router Session the ingress sequence. A filtered Trigger
   * is global coordination context (default shard); an admitted one is written
   * to every shard that routed it so each resident Router sees its own work.
   */
  private observeIngress(
    trigger: Trigger,
    verdict: FilterVerdict,
    trust: TriggerTrust,
    result: ReceiveResult,
  ): void {
    const text = trigger.text.replace(/\s+/g, ' ').trim().slice(0, 160)
    if (verdict.action !== 'pass') {
      this.harness.routerObserve('default', {
        kind: 'trigger.filtered',
        triggerId: trigger.id,
        reason: `${verdict.layer}:${verdict.reason}`,
        text,
      })
      return
    }
    for (const shard of trust.shards ?? ['default']) {
      this.harness.routerObserve(shard, {
        kind: `trigger.${result}`,
        triggerId: trigger.id,
        threads: trigger.threads.map(threadKey),
        actor: `${trigger.actor.source}:${trigger.actor.id}`,
        text,
      })
    }
  }

  /**
   * Locality for a new Trigger: the three most recent Triggers in the same
   * Thread are inlined as next-hop refs, so the model does not need a search
   * tool call to see the immediately preceding messages.
   */
  private neighborTriggerRefs(trigger: Trigger): ObjectRef[] {
    const keys = new Set(trigger.threads.map(threadKey))
    return this.store.listDocs<Trigger>('trigger')
      .filter(item => item.id !== trigger.id && item.threads.some(ref => keys.has(threadKey(ref))))
      .slice(-3)
      .map(item => triggerRef(
        item.id,
        typeof item.meta.label === 'string' ? item.meta.label : undefined,
      ))
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

  /**
   * Record the owner's approval decision, then start the RESUME turns. The
   * decision and its guidance commit before any model call.
   */
  async decideApproval(
    ticketId: string,
    approvalId: string,
    decision: 'approved' | 'denied',
    note?: string,
  ): Promise<DecideApprovalOutcome> {
    const outcome = this.engine.decideApproval(ticketId, approvalId, decision, {
      ...(note ? { note } : {}),
    })
    if (!outcome.ticket.ended) await this.harness.resume(outcome.ticket)
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
      // Local specialists run detached in their own process group, so they
      // would outlive this process. Kill them before draining: shutdown must
      // not block on a slow agent, and no child may survive finish().
      this.localAgents?.killAll()
      await this.assessmentsSettled()
      this.flushEvals()
      await this.harness.jobsSettled()
    } catch (error) {
      remember(error)
    } finally {
      // The daemon timer, MCP child processes, and SQLite handle must all be
      // released even when a drain step rejects.
      this.daemon.stop()
      this.remoteResultWait?.clearAll()
      try {
        await this.tools.close()
      } catch (error) {
        remember(error)
      }
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
 * `DS_AGENT_MCP_SERVERS` (or `RuntimeOptions.mcpServers`) is configuration, not
 * code: malformed config is reported and ignored so a bad file cannot stop the
 * runtime from starting. The caller logs `error` once a logger exists.
 */
function mcpServersFromConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv,
): { configs: McpServerConfig[]; error?: string } {
  let value = raw
  if (value === undefined) {
    const configured = env.DS_AGENT_MCP_SERVERS?.trim()
    if (!configured) return { configs: [] }
    value = configured
  }
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch (error) {
      return { configs: [], error: error instanceof Error ? error.message : String(error) }
    }
  }
  try {
    return { configs: parseMcpServers(value) }
  } catch (error) {
    return { configs: [], error: error instanceof Error ? error.message : String(error) }
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

/**
 * Durable lifecycle-log retention. The default is the in-memory replay window
 * so a restart can refill the ring completely. A larger explicit value keeps a
 * longer audit history without changing the bounded in-memory view; a smaller
 * value is raised to `maxEvents` for the same reason.
 */
function lifecycleRetentionFor(requested: number | undefined, maxEvents: number): number {
  if (requested === undefined) return maxEvents
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new Error('lifecycleRetention must be a positive integer')
  }
  return Math.max(maxEvents, requested)
}

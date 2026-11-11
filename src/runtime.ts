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
import { pendingApproval } from './core/collab.ts'
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
import { WorkerPlacement, requiredMeshCapabilities } from './harness/mesh-runtime.ts'
import {
  RemoteMeshResultWait,
  remoteResultTimeoutMsFromEnv,
} from './harness/remote-mesh-wait.ts'
import { recordRemoteResult, remoteResultSeen } from './harness/remote-results.ts'
import type { RemoteMeshAssignmentResultEvent } from './harness/remote-node.ts'
import type { WorkerReport } from './shared/ports.ts'
import { Logger } from './shared/log.ts'
import { threadKey, type Assignment, type Disposition, type ObjectRef, type ReceiveResult, type Thread, type Ticket, type Trigger, type TriggerTrust } from './shared/types.ts'
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
 * Report kinds that end an Assignment (`src/core/assignments.ts`). A remote
 * result with one of these is settled even when a pause holds its verdict.
 */
const REMOTE_ENDING_REPORT_KINDS = new Set(['ready', 'failed', 'dropped', 'blocked', 'waiting'])

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
  /** Shared slot-release/cancel path, bound in the factory closure. */
  private readonly releaseSlot: (ticketId: string) => void
  /**
   * In-flight fail-soft remote cancel sends, keyed by ticketId. Shared with the
   * factory-side `releaseSlot` so a replacement launch can wait for a
   * superseded Assignment's cancel to settle first.
   */
  private readonly remoteCancelSends: Map<string, Set<Promise<void>>>
  /** Per-Ticket gates that hold a replacement's remote assignment body. */
  private readonly remoteDispatchBarriers: Map<string, Promise<void>>
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
    releaseSlot: (ticketId: string) => void
    remoteCancelSends: Map<string, Set<Promise<void>>>
    remoteDispatchBarriers: Map<string, Promise<void>>
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
    this.releaseSlot = parts.releaseSlot
    this.remoteCancelSends = parts.remoteCancelSends
    this.remoteDispatchBarriers = parts.remoteDispatchBarriers
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
      // The timer belongs to the Assignment captured when it was armed. Every
      // report path mutates the *latest* Assignment, so recovering or ending
      // that Assignment can leave this timer pointing at a replacement. Failing
      // the replacement for the old Assignment's missing result would be wrong.
      const ticket = store.getDoc<Ticket>('ticket', ticketId)
      const armed = ticket?.assignments.find(item => item.id === assignmentId)
      const latest = ticket?.assignments.at(-1)
      const staleReason = !ticket
        ? 'missing-ticket'
        : ticket.ended
          ? 'ticket-ended'
          : !armed
            ? 'missing-assignment'
            : armed.state === 'ended'
              ? 'assignment-ended'
              : latest?.id !== assignmentId
                ? 'assignment-replaced'
                : undefined
      if (staleReason) {
        log.info(
          `[mesh] remote result timeout ignored ticketId=${ticketId} assignmentId=${assignmentId} reason=${staleReason}`,
        )
        // A newer Assignment may already own this ticket's remote reservation:
        // sticky placement keeps the slot, so a replacement that has claimed
        // the node or started work must not lose capacity to the stale timer.
        const liveReplacement = latest !== undefined
          && latest.id !== assignmentId
          && latest.state !== 'ended'
          && (latest.state === 'running' || latest.node !== undefined || latest.startedAt !== undefined)
          && placement.remoteHasTicket(ticketId)
        if (liveReplacement) {
          log.info(
            `[mesh] remote result timeout kept slot ticketId=${ticketId} assignmentId=${assignmentId} replacementId=${latest?.id} reason=live-replacement`,
          )
          // The fired timer deleted itself (the wait is keyed per ticket) before
          // this callback ran. A live replacement that has not yet armed its own
          // wait would otherwise hold the sticky slot forever with no recovery.
          // Transfer the wait to the replacement.
          if (latest) {
            if (remoteResultTimeoutMs > 0) {
              log.info(
                `[mesh] remote result wait armed ticketId=${ticketId} assignmentId=${latest.id}`,
              )
            }
            late.remoteResultWait?.arm(ticketId, latest.id)
          }
          return
        }
        // Recovery can end the Assignment without going through `releaseMesh`.
        // Free any capacity it left reserved; do not invent another way to end
        // the Assignment or the Ticket.
        placement.release(ticketId)
        return
      }
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
        return
      }
      // `report` may hold instead of ending, for example while the Ticket is
      // paused: the failed verdict is persisted on the Assignment and only
      // applied on resume. The timer deleted itself before firing, so without
      // re-arming this Ticket would never time out again and its mesh slot
      // would stay reserved forever. Check the post-report Assignment state
      // rather than only `collab.paused` so every hold path is covered.
      const reported = store.getDoc<Ticket>('ticket', ticketId)
      const armedAfterReport = reported?.assignments.find(item => item.id === assignmentId)
      if (reported && !reported.ended && armedAfterReport && armedAfterReport.state !== 'ended') {
        log.info(
          `[mesh] remote result timeout deferred ticketId=${ticketId} assignmentId=${assignmentId} reason=assignment-still-open`,
        )
        late.remoteResultWait?.arm(ticketId, assignmentId)
      }
    })
    /**
     * In-flight remote cancel sends per Ticket.
     *
     * `releaseSlot` deliberately does not await `cancelRemote`: the slot-settle
     * `finally` remains the single owner of keep-vs-release. But a replacement
     * must not reach a Worker that still holds a superseded ended Assignment
     * before that fail-soft cancel has at least settled (sent, or failed soft).
     * Recovery and `Runtime.retry` gate the replacement's remote body on these
     * batches; slot release is not what they wait for.
     */
    const remoteCancelSends = new Map<string, Set<Promise<void>>>()
    /**
     * The same fail-soft cancel batches, additionally keyed by the node they
     * target (value = owning ticketId + Assignment id). `remoteCancelSends` is
     * per Ticket, so a later *different* Ticket launched onto the same worker
     * cannot use it to order against an older Ticket's delayed cancel; this map
     * is what that cross-Ticket wait reads. The Assignment id lets a same-Ticket
     * dispatch tell an in-flight cancel for one ended Assignment from a settled
     * lost cancel for another (see `resendOwnOrphanedRemoteCancels`). Only
     * observers are added here, the cancel transport and slot accounting are
     * untouched.
     */
    const remoteCancelSendsByNode = new Map<
      string,
      Map<Promise<void>, { ticketId: string; assignmentId: string }>
    >()
    /**
     * Per-Ticket gate that holds a replacement's remote assignment body until
     * the superseded Assignment's cancels settle. Placement already happened,
     * so slot accounting is untouched; only the wire body waits.
     */
    const remoteDispatchBarriers = new Map<string, Promise<void>>()
    /**
     * Tickets whose ended remote Assignments a Worker may still hold because
     * their cancel was lost.
     *
     * `cancelEndedRemoteAssignments` records a Ticket when local placement
     * starts the fail-soft cancels. That send can itself be lost (the very
     * failure this path exists for), and then a later different Ticket placed
     * on the same Worker would reach it while it still holds the old
     * Assignment. The record lets that later `dispatchRemote` re-send from
     * committed state right before its own body; the node-keyed
     * `remoteCancelSendsByNode` wait below then orders the body after the
     * cancel. The keep-slot path records a Ticket when it *starts* its ended
     * predecessor cancels too, even though a live replacement keeps the sticky:
     * keeping the sticky must not hide a lost predecessor cancel.
     *
     * The record is consumed only once a delivered batch covers every ended
     * remote left in committed state; a dispatch to a different node, or a lost
     * re-send, leaves it in place so that node can still resend. A Ticket that
     * has since gained a remote sticky is not dropped for that reason alone.
     * The no-sticky `releaseSlot` backstop also drops the record once the local
     * replacement ends, but only after its last-attempt cancels are actually
     * delivered *and* a re-read has no uncovered ended remote left: a lost last
     * attempt keeps the record so a later dispatch can still resend it. The
     * set is therefore bounded by Tickets that still have an uncovered ended
     * remote Assignment or a live local replacement, or
     * whose last-attempt (or later dispatch-time) cancel has not yet been
     * delivered.
     */
    const orphanedRemoteTickets = new Set<string>()
    const trackRemoteCancelSends = (
      ticketId: string,
      assignmentId: string,
      sends: Promise<unknown>[],
      node: string | undefined,
    ): void => {
      if (sends.length === 0) return
      let pending = remoteCancelSends.get(ticketId)
      if (!pending) {
        pending = new Set()
        remoteCancelSends.set(ticketId, pending)
      }
      const batch = Promise.allSettled(sends).then(() => undefined)
      pending.add(batch)
      if (node !== undefined) {
        let byNode = remoteCancelSendsByNode.get(node)
        if (!byNode) {
          byNode = new Map()
          remoteCancelSendsByNode.set(node, byNode)
        }
        byNode.set(batch, { ticketId, assignmentId })
      }
      void batch.finally(() => {
        pending.delete(batch)
        if (pending.size === 0 && remoteCancelSends.get(ticketId) === pending) {
          remoteCancelSends.delete(ticketId)
        }
        if (node !== undefined) {
          const nodePending = remoteCancelSendsByNode.get(node)
          nodePending?.delete(batch)
          if (nodePending && nodePending.size === 0
            && remoteCancelSendsByNode.get(node) === nodePending) {
            remoteCancelSendsByNode.delete(node)
          }
        }
      })
    }
    /**
     * Wait until every fail-soft remote cancel send to `node` that belongs to a
     * *different* Ticket has settled.
     *
     * The per-Ticket dispatch barrier fences a replacement against its own
     * Ticket's cancels. It cannot see a later Ticket placed on the same worker,
     * so with spare worker capacity that body would reach the worker while it
     * still holds an older Ticket's ended Assignment. This is the cross-Ticket
     * counterpart; only the wire body waits, placement and keep-vs-release are
     * unchanged.
     *
     * The current Ticket's batches are excluded on purpose: `Runtime.retry`
     * deliberately skips same-Ticket sends already in flight when it was called
     * (so a held keep-slot cancel cannot deadlock a relaunch), and the
     * per-Ticket barrier owns that ordering. Sends are fail-soft, so an
     * unregistered, ineligible, or offline target settles instead of hanging
     * the dispatch. The yield first makes a `releaseSlot` microtask queued in
     * the same turn visible before deciding there is nothing to wait for.
     */
    const settleRemoteCancelSendsToNode = async (
      node: string,
      ticketId: string,
    ): Promise<void> => {
      await Promise.resolve()
      for (;;) {
        const byNode = remoteCancelSendsByNode.get(node)
        if (!byNode) return
        const pending = [...byNode]
          .filter(([, owner]) => owner.ticketId !== ticketId)
          .map(([batch]) => batch)
        if (pending.length === 0) return
        await Promise.allSettled(pending)
      }
    }
    const notifyHarnessReleased = (ticketId: string): void => {
      try {
        late.harness?.release(ticketId)
      } catch (error) {
        log.info(`[hook] hook=harness-release ticketId=${ticketId} error=${error instanceof Error ? error.message : String(error)}`)
      }
    }
    /**
     * Every ended remote Assignment that a later Assignment superseded.
     *
     * The nearest ended row is not enough to authenticate the cancel: a Worker
     * can still hold an older Assignment whose `assignment_cancel` never
     * arrived. For example recovery in a previous process ended A1 and
     * dispatched A2 on the same Worker, then a later recovery ended the running
     * A2 and appended A3. Assignments are now A1 ended, A2 ended, A3 open; the
     * Worker still running A1 must be told to stop it as well as A2.
     *
     * The same lost-cancel window exists without a later open Assignment: A1's
     * cancel is lost, A2 runs in the same process, then A2 ends through the
     * normal report/timeout/retry path and is itself `latest`. Those older
     * ended rows still own remote reservations the Worker may hold, so return
     * them there too. Duplicate cancels are fail-soft (the Worker ignores an
     * unknown/already-ended id), and every send uses `{ release: false }` so
     * the settle policy below remains the single owner of keep-vs-release.
     */
    const supersededRemoteAssignments = (snapshot: Ticket | undefined): Assignment[] => {
      const latest = snapshot?.assignments.at(-1)
      if (!snapshot || !latest) return []
      return snapshot.assignments
        .slice(0, -1)
        .filter(item =>
          item.state === 'ended'
          && item.node !== undefined
          && placement.isRemote(item.node))
    }
    /**
     * Every ended remote Assignment whose worker may still hold it, including
     * `latest` when it is itself an ended remote row.
     *
     * `supersededRemoteAssignments` stops at `latest` because the sticky-slot
     * paths cancel `latest` separately. The no-sticky path has no sticky
     * reservation to reason about, so it needs the whole set: a local
     * replacement can supersede a remote Assignment whose cancel was lost, and
     * the worker that still holds that historical Assignment must be told to
     * stop even though the Ticket no longer reserves any remote slot.
     */
    const endedRemoteAssignments = (snapshot: Ticket | undefined): Assignment[] => {
      const latest = snapshot?.assignments.at(-1)
      const superseded = supersededRemoteAssignments(snapshot)
      const latestEndedRemote = latest !== undefined
        && latest.state === 'ended'
        && latest.node !== undefined
        && placement.isRemote(latest.node)
        ? [latest]
        : []
      return [...superseded, ...latestEndedRemote]
    }
    /**
     * Fail-soft, voided cancel for one ended remote Assignment. Targets the
     * node recorded on that Assignment and leaves keep-vs-release untouched;
     * the send is tracked under that node so a later different Ticket's
     * `dispatchRemote` can order its body after it.
     */
    const sendEndedRemoteCancel = (
      ticketId: string,
      target: Pick<Assignment, 'id' | 'node'>,
      // Node to attribute the send to when the Assignment row did not record
      // one; the sticky-path settle path only has the Ticket's current node.
      fallbackNode?: string,
    ): Promise<boolean> => {
      const node = target.node ?? fallbackNode
      const settled = placement.cancelRemote(ticketId, target.id, {
        release: false,
        ...(node !== undefined ? { nodeId: node } : {}),
      }).then(
        delivered => delivered,
        error => {
          log.info(
            `[mesh] remote cancel failed ticketId=${ticketId} error=${error instanceof Error ? error.message : String(error)}`,
          )
          return false
        },
      )
      trackRemoteCancelSends(ticketId, target.id, [settled], node)
      return settled
    }
    /**
     * Drop an orphan record only when this batch actually covered every ended
     * remote Assignment committed state still knows about.
     *
     * A live replacement holding the sticky does not own the record: the ended
     * predecessor's cancel can still have been lost, and keeping the sticky must
     * not hide that. A lost send keeps the record so a later same-node dispatch
     * can resend it. A closed Store has no committed state to decide from and
     * leaves the record to the shutdown owners (`finish()` never waits on cancel
     * HTTP).
     */
    const consumeOrphanedRemoteCancels = (
      ticketId: string,
      cancelled: ReadonlyArray<Pick<Assignment, 'id'>>,
      delivered: boolean,
    ): void => {
      if (!delivered) return
      if (!store.isOpen) return
      const current = store.getDoc<Ticket>('ticket', ticketId)
      if (!current) {
        // No committed Ticket remains, so the record can never produce a send.
        orphanedRemoteTickets.delete(ticketId)
        return
      }
      const cancelledIds = new Set(cancelled.map(target => target.id))
      // Re-read committed state: only ended remotes this delivered batch did not
      // cover still need a later resend. Any node keeps the record (f23e9e5).
      const remaining = endedRemoteAssignments(current)
        .filter(target => !cancelledIds.has(target.id))
      if (remaining.length === 0) orphanedRemoteTickets.delete(ticketId)
    }
    /**
     * Tell every Worker that may still hold an ended remote Assignment for this
     * Ticket to stop, without touching keep-vs-release.
     *
     * This is the no-sticky counterpart to the sticky-slot cancel paths: a
     * local replacement means the Ticket will never reclaim a remote
     * reservation, so the only reason to cancel an ended remote row is the
     * Worker still holding it. `releaseSlot` also calls this when the local
     * replacement ends, but that is too late: a later different Ticket can be
     * placed on the same Worker while the local replacement still runs, and
     * `dispatchRemote`'s cross-Ticket wait can only order after a cancel that
     * has actually started. Sending at local placement starts it early; the
     * node-attributed tracking then fences that later Ticket's body.
     *
     * `{ release: false }` leaves keep-vs-release to the sticky settle path,
     * and the send is voided so `finish()` never waits on cancel HTTP.
     * Duplicate sends stay fail-soft: the Worker ignores a cancel for an
     * Assignment it already dropped.
     */
    const cancelEndedRemoteAssignments = (
      ticketId: string,
      ticket: Ticket | undefined = store.getDoc<Ticket>('ticket', ticketId),
    ): { targets: Assignment[]; sends: Promise<boolean>[] } => {
      const targets = endedRemoteAssignments(ticket)
      if (targets.length === 0) return { targets, sends: [] }
      // Keep the Ticket marked until the local replacement releases: this send
      // is fail-soft, so a later different Ticket placed on the same Worker may
      // still need to re-send before its own body reaches it.
      orphanedRemoteTickets.add(ticketId)
      const sends = targets.map(target => sendEndedRemoteCancel(ticketId, target))
      return { targets, sends }
    }
    /**
     * Is this exact ended remote Assignment's cancel already being sent to
     * `node` by this Ticket?
     *
     * Tracking is per Assignment, not per Ticket: a same-Ticket dispatch must
     * still be able to resend a *settled lost* cancel for one Assignment while
     * an older sibling cancel on the same Ticket and node is still in flight.
     */
    const cancelSendInFlightToNode = (
      node: string,
      ticketId: string,
      assignmentId: string,
    ): boolean => {
      const byNode = remoteCancelSendsByNode.get(node)
      if (!byNode) return false
      for (const owner of byNode.values()) {
        if (owner.ticketId === ticketId && owner.assignmentId === assignmentId) {
          return true
        }
      }
      return false
    }
    /**
     * Key for a cancel target this dispatch already attempted.
     *
     * The post-wait drain may start a *new* orphan that appeared while the
     * body was held, but it must never retry a target this dispatch already
     * attempted and lost: a failing endpoint would spin the drain forever, and
     * the orphan record is deliberately kept for a later Ticket/retry
     * (existing policy). The owning Ticket is part of the key so the same
     * Assignment id could never make one Ticket's attempt suppress another's.
     */
    const remoteCancelAttemptKey = (ticketId: string, assignmentId: string): string =>
      `${ticketId}\u0000${assignmentId}`
    /**
     * Re-send this Ticket's own uncovered ended remotes on `node` before its
     * replacement body reaches the Worker.
     *
     * `resendOrphanedRemoteCancels` deliberately skips the dispatching Ticket:
     * for a *different* Ticket that is a drive-by cancel. But `Runtime.retry`
     * reuses the same dispatch path for the Ticket being relaunched. Its lost
     * terminal cancel may already have settled, leaving no in-flight batch and
     * no barrier, while the Worker still holds the ended Assignment. The
     * relaunch is not a drive-by, so resend before the body and let the caller
     * hold it until these new sends settle.
     *
     * Only a target whose own cancel is already in flight to this node is left
     * alone: starting a duplicate would let a delayed/held endpoint hold the
     * duplicate too, and the caller awaits the sends started here, which would
     * block the replacement body — the 2a2de80 tradeoff. An in-flight cancel
     * for a *different* ended Assignment on the same Ticket does not suppress
     * the resend of a settled lost one; the caller then awaits only the new
     * sends, never the older in-flight batch. The record is kept on a lost send
     * and consumed only when a delivered batch covers every ended remote in a
     * re-read (`consumeOrphanedRemoteCancels`), so a later different Ticket, or
     * a further later retry, can try again.
     */
    const resendOwnOrphanedRemoteCancels = (
      node: string,
      ticketId: string,
      attempted?: Set<string>,
    ): Promise<boolean>[] => {
      if (!store.isOpen) return []
      if (!orphanedRemoteTickets.has(ticketId)) return []
      const ticket = store.getDoc<Ticket>('ticket', ticketId)
      if (!ticket) {
        orphanedRemoteTickets.delete(ticketId)
        return []
      }
      // The dispatching Ticket is being actively relaunched, so the
      // paused/approval-held drive-by skip does not apply to its own resend.
      // Skip only targets whose own cancel is already in flight; a settled lost
      // sibling cancel on this node must still be resent.
      const targets = endedRemoteAssignments(ticket)
        .filter(target => target.node === node)
        .filter(target =>
          !attempted?.has(remoteCancelAttemptKey(ticketId, target.id)))
        .filter(target =>
          !cancelSendInFlightToNode(node, ticketId, target.id))
      if (targets.length === 0) return []
      for (const target of targets) {
        attempted?.add(remoteCancelAttemptKey(ticketId, target.id))
      }
      const sends = targets.map(target => sendEndedRemoteCancel(ticketId, target))
      void Promise.all(sends).then(outcomes =>
        consumeOrphanedRemoteCancels(ticketId, targets, outcomes.every(Boolean)),
      )
      return sends
    }
    /**
     * Re-send a Ticket's orphaned ended-remote cancels before a *different*
     * Ticket's body reaches the same Worker.
     *
     * Local placement already started these cancels, but that send is
     * fail-soft: when it was lost, the Worker still holds the old Assignment
     * when a later Ticket is placed on the same node. Re-read committed state
     * and send the targets for this node now; the node-keyed wait in
     * `dispatchRemote` then holds the later body until they settle. The record
     * is consumed only when a dispatch-time re-send to the owning node
     * *succeeds*; a dispatch to a different node leaves it in place, and a lost
     * same-node re-send also leaves it so a further later Ticket on the owning
     * node can resend. The local replacement's own no-sticky `releaseSlot`
     * backstop owns any later attempt. Paused or approval-held Tickets are left
     * alone (and stay recorded, since no cancel was attempted).
     *
     * A live replacement that keeps a remote sticky does *not* own the record:
     * its ended predecessor's cancel can still have been lost, and the sticky
     * must not hide that. Only an actually delivered resend whose re-read has no
     * uncovered ended remote on any node consumes the record.
     */
    const resendOrphanedRemoteCancels = (
      node: string,
      dispatchingTicketId: string,
      attempted?: Set<string>,
    ): Promise<boolean>[] => {
      const started: Promise<boolean>[] = []
      // No committed state to re-derive targets from after `finish()` closes
      // the Store; a dispatch this late must not throw on a closed handle.
      if (!store.isOpen) return started
      for (const ticketId of orphanedRemoteTickets) {
        if (ticketId === dispatchingTicketId) continue
        const ticket = store.getDoc<Ticket>('ticket', ticketId)
        if (!ticket) {
          // No committed Ticket remains to derive targets from, so the record
          // can never produce a send. Drop it rather than leak the id.
          orphanedRemoteTickets.delete(ticketId)
          continue
        }
        // Paused/approval-held Tickets are never cancelled as a drive-by. Keep
        // the record: no send was attempted, and a later dispatch after
        // recovery may still need to re-send it.
        if (ticket.collab?.paused || pendingApproval(ticket)) continue
        // Only targets recorded on *this* node are in scope. If every ended
        // remote Assignment lives elsewhere, leave the record so a dispatch to
        // that node can still resend it. A target this dispatch already tried
        // (and may have lost) is left to a later Ticket/retry, never retried
        // here.
        const targets = endedRemoteAssignments(ticket)
          .filter(target => target.node === node)
          .filter(target =>
            !attempted?.has(remoteCancelAttemptKey(ticketId, target.id)))
        if (targets.length === 0) continue
        for (const target of targets) {
          attempted?.add(remoteCancelAttemptKey(ticketId, target.id))
        }
        // Keep the record in place while these sends are in flight and only
        // consume it once every one succeeds. A lost send (fail-soft 502) must
        // leave the record so a *further* later dispatch to this node can
        // resend; deleting synchronously before the send settles would burn it
        // on a resend that was itself lost. A concurrent same-node dispatch may
        // start a duplicate cancel while this one is in flight, which is fine:
        // the Worker ignores a cancel for an Assignment it already dropped, and
        // `settleRemoteCancelSendsToNode` orders the later body after both.
        const sends = targets.map(target => sendEndedRemoteCancel(ticketId, target))
        started.push(...sends)
        void Promise.all(sends).then(outcomes => {
          // A lost same-node resend keeps the record (e240f87): a further later
          // dispatch to this node must be able to resend it.
          if (!outcomes.every(Boolean)) return
          // The Store may have closed while the send was in flight. There is no
          // committed state left to decide from, and the closed-Store path at
          // the top of this function is a no-op; leave the record for the
          // releaseSlot/finish paths that own shutdown.
          if (!store.isOpen) return
          const current = store.getDoc<Ticket>('ticket', ticketId)
          if (!current) {
            // No committed Ticket remains, so the record can never produce a
            // send.
            orphanedRemoteTickets.delete(ticketId)
            return
          }
          // Paused/approval-held Tickets are never cancelled as a drive-by and
          // stay recorded (existing policy).
          if (current.collab?.paused || pendingApproval(current)) return
          // Succeeding on *this* node must not consume ended remotes recorded on
          // another node: a later dispatch there still has to resend before its
          // body reaches the Worker that may still hold them. A remote sticky
          // gained since (a live replacement) does not consume either; only a
          // re-read with no uncovered ended remote left does.
          const cancelledIds = new Set(targets.map(target => target.id))
          const remaining = endedRemoteAssignments(current)
            .filter(target => !cancelledIds.has(target.id))
          if (remaining.length === 0) orphanedRemoteTickets.delete(ticketId)
        })
      }
      return started
    }
    /**
     * Free one ticket's Worker slot, then let the scheduler pump.
     *
     * A local slot is free synchronously, so `release` can pump immediately.
     * A remote slot is only free after `cancelRemote` settles: `dispatchCancel`
     * awaits the HTTP send and `WorkerPlacement.cancelRemote` releases the
     * registry assignment in its `finally`. Pumping before that settles sees a
     * still-full mesh, parks the head of the queue, and nothing would pump again
     * once the cancel frees capacity. Notify after the cancel settles instead.
     *
     * Extra pumps are harmless: `Harness.release` skips a ticket whose Worker
     * turn is still active, and `pump` reserves a slot before starting a turn.
     */
    const releaseSlot = (ticketId: string): void => {
      try {
        const ticket = store.getDoc<Ticket>('ticket', ticketId)
        const latest = ticket?.assignments.at(-1)
        const assignmentId = latest?.id
        if (assignmentId && placement.remoteHasTicket(ticketId)) {
          // Attribute these fail-soft cancels to the node they target while the
          // sticky reservation still exists. A later different Ticket placed on
          // the same node reads this to order its assignment body after them.
          const cancelNode = placement.remoteNodeFor(ticketId)
          // `releaseSlot` is also reached from `releaseNode` while the only
          // Assignment is still the live running one (the Worker failed before
          // it started). A newer open Assignment alone is therefore not proof
          // of a replacement: require a prior ended Assignment it superseded.
          const ended = ticket?.assignments.slice(0, -1).reverse().find(item => item.state === 'ended')
          const liveReplacement = ticket !== undefined
            && !ticket.ended
            && latest !== undefined
            && latest.state !== 'ended'
            && (latest.state === 'running' || latest.node !== undefined || latest.startedAt !== undefined)
            && ended !== undefined
            && placement.remoteHasTicket(ticketId)
          if (liveReplacement && ended) {
            log.info(
              `[mesh] remote cancel kept slot ticketId=${ticketId} assignmentId=${ended.id} replacementId=${latest?.id} reason=live-replacement`,
            )
            // `releaseMesh` already cleared the only per-ticket wait before this
            // microtask ran. A live replacement that has not yet armed its own
            // wait would otherwise hold the sticky slot forever with no recovery.
            // Transfer the wait to the replacement, matching the stale-timeout
            // and late dispatch keep-slot paths.
            if (latest) {
              if (remoteResultTimeoutMs > 0) {
                log.info(
                  `[mesh] remote result wait armed ticketId=${ticketId} assignmentId=${latest.id}`,
                )
              }
              late.remoteResultWait?.arm(ticketId, latest.id)
            }
            // Still tell every ended remote worker Assignment to stop, but keep
            // the sticky reservation so the live replacement does not lose its
            // slot. A Worker may still hold an older predecessor whose cancel
            // was lost, so send them all; duplicates stay fail-soft. Each
            // cancel targets the node recorded on that Assignment: the sticky
            // reservation may have moved to a different remote node after an
            // earlier lost cancel freed it, and the worker that still holds the
            // old Assignment is the one that must stop.
            const keepSlotTargets = supersededRemoteAssignments(ticket)
            // Record the Ticket as soon as these cancels are *started*, not only
            // after a loss is observed. A later dispatch can race the in-flight
            // first send; if that send is then lost, the dispatch-time resend
            // must already have a record to resend from. Keeping the sticky with
            // the live replacement does not consume it.
            if (keepSlotTargets.length > 0) orphanedRemoteTickets.add(ticketId)
            const keepSlotSends = keepSlotTargets.map(target =>
              sendEndedRemoteCancel(ticketId, target, cancelNode),
            )
            void Promise.all(keepSlotSends).then(
              outcomes => {
                // Keep-vs-release is unchanged (the sticky stays with the live
                // replacement); only decide whether a lost predecessor cancel
                // must stay resendable.
                consumeOrphanedRemoteCancels(
                  ticketId,
                  keepSlotTargets,
                  outcomes.every(Boolean),
                )
                notifyHarnessReleased(ticketId)
              },
              () => notifyHarnessReleased(ticketId),
            )
            return
          }
          // No live replacement is visible yet, but the cancel send awaits the
          // network. A genuine relaunch (for example `Runtime.retry`) can place,
          // dispatch, and start a replacement while this send is in flight.
          // Cancel without releasing, then decide after the send settles: a
          // blind `release` here would steal the slot the replacement now runs
          // on. Re-read the committed Ticket and apply the same live-replacement
          // predicate as the synchronous keep-slot branch above.
          //
          // Cancel every Assignment that ran remotely and is being ended or
          // superseded. `latest` can be a not-yet-live pending replacement
          // (for example `recoverInterrupted` appends A2 before releasing A1's
          // slot): authenticating the cancel for that pending id would leave the
          // Assignment still running on the worker untouched. When `latest` is
          // still open and predecessors already ended, every one of them owns a
          // remote reservation the Worker may still hold.
          //
          // When `latest` itself is the ended Assignment (normal report/timeout/
          // retry), its own cancel is required, but an older predecessor's
          // cancel may also have been lost (A1 dropped, A2 ran and ended in the
          // same process). Send every older ended remote id as well; duplicates
          // stay fail-soft and `{ release: false }` keeps settle policy single.
          const supersededEnded = supersededRemoteAssignments(ticket)
          const cancelAssignmentIds = latest?.state !== 'ended'
            ? (ended !== undefined
              ? (supersededEnded.length > 0 ? supersededEnded.map(item => item.id) : [ended.id])
              : assignmentId ? [assignmentId] : [])
            : supersededEnded.length > 0
              ? [...supersededEnded.map(item => item.id), ...(assignmentId ? [assignmentId] : [])]
              : assignmentId ? [assignmentId] : []
          // Resolve each id back to its Assignment so the cancel goes to the
          // node that actually ran it (`assignment.node`), not the Ticket's
          // current sticky reservation. A lost earlier cancel can conservatively
          // free the old slot and let a retry land on a different remote node;
          // the worker still holding the older Assignment is on the old node.
          const byId = new Map((ticket?.assignments ?? []).map(item => [item.id, item]))
          // Record the Ticket as soon as these terminal cancels are started, not
          // only after a loss is observed. A later dispatch can race the
          // in-flight first send; if that send is then lost, the dispatch-time
          // resend must already have a record to resend from.
          if (cancelAssignmentIds.length > 0) orphanedRemoteTickets.add(ticketId)
          const cancelSends = cancelAssignmentIds.map(id =>
            sendEndedRemoteCancel(ticketId, byId.get(id) ?? { id }, cancelNode),
          )
          const settleAfterCancelSends = (delivered: boolean): void => {
            // `Runtime.finish()` (or a crash-simulation / teardown that closes
            // SQLite directly) can close the Store while this fail-soft cancel
            // send is still in flight. There is no committed state left to
            // decide keep-vs-release from, and every Store read on a closed
            // handle throws `database is not open`. This promise is voided, so
            // letting that throw escape would surface as an unhandled
            // rejection. Fail soft in memory instead: release the sticky slot
            // (no live replacement can be proven) and notify the harness,
            // neither of which needs the Store. Leave the orphan record for the
            // shutdown owners; there is no state left to consume it from here.
            if (!store.isOpen) {
              placement.release(ticketId)
              notifyHarnessReleased(ticketId)
              return
            }
            const current = store.getDoc<Ticket>('ticket', ticketId)
            const currentLatest = current?.assignments.at(-1)
            const superseded = current?.assignments
              .slice(0, -1).reverse().find(item => item.state === 'ended')
            const liveReplacement = current !== undefined
              && !current.ended
              && currentLatest !== undefined
              && currentLatest.state !== 'ended'
              && (currentLatest.state === 'running'
                || currentLatest.node !== undefined
                || currentLatest.startedAt !== undefined)
              && superseded !== undefined
              && placement.remoteHasTicket(ticketId)
            if (liveReplacement && superseded && currentLatest && current) {
              log.info(
                `[mesh] remote cancel kept slot ticketId=${ticketId} assignmentId=${superseded.id} replacementId=${currentLatest.id} reason=live-replacement`,
              )
              // The replacement's own wait may already be armed; arming is
              // keyed per ticketId and resetting it to the live replacement
              // is the same transfer the other late keep-slot paths make.
              if (remoteResultTimeoutMs > 0) {
                log.info(
                  `[mesh] remote result wait armed ticketId=${ticketId} assignmentId=${currentLatest.id}`,
                )
              }
              late.remoteResultWait?.arm(ticketId, currentLatest.id)
              // Keep the sticky with the live replacement, but do not drop the
              // record merely because the sticky was kept: a lost predecessor
              // cancel must stay resendable by a later same-node dispatch.
              consumeOrphanedRemoteCancels(
                ticketId,
                cancelAssignmentIds.map(id => ({ id })),
                delivered,
              )
            } else {
              placement.release(ticketId)
              // A lost terminal cancel with the sticky released must stay
              // recorded: a later different Ticket placed on the same Worker
              // has nothing else to resend, and the Worker still holds this
              // ended Assignment. Re-add rather than assume the record is
              // still present: a delivered last-attempt batch (or a
              // dispatch-time resend) can consume it while this batch waits on
              // a delayed send of its own.
              if (!delivered) {
                orphanedRemoteTickets.add(ticketId)
              } else {
                // A sticky gained while the send was in flight does not
                // consume the record by itself, and this batch may not cover
                // every ended remote (for example an Assignment appended after
                // the snapshot). Re-read committed state and drop the record
                // only when it has no uncovered ended remote left.
                consumeOrphanedRemoteCancels(
                  ticketId,
                  cancelAssignmentIds.map(id => ({ id })),
                  delivered,
                )
              }
            }
            notifyHarnessReleased(ticketId)
          }
          void Promise.all(cancelSends).then(
            outcomes => settleAfterCancelSends(outcomes.every(Boolean)),
            () => settleAfterCancelSends(false),
          )
          return
        }
        // No remote sticky reservation: the Ticket's replacement is local (or
        // there is none). A worker can still hold an older remote Assignment
        // whose `assignment_cancel` was lost, for example a local-first retry
        // that ran after a lost cancel conservatively freed the remote slot.
        // Keep this as the backstop for a replacement that ends later; local
        // placement already sent the same fail-soft cancels (duplicates are
        // harmless). Local capacity below is still freed synchronously and
        // `finish()` never waits on the HTTP send. The replacement is ending,
        // so this is the last attempt — but a lost last attempt must not burn
        // the orphan record: a later different Ticket placed on the same Worker
        // still has to resend it. Consume the record only once every
        // last-attempt send is delivered and committed state has no ended
        // remote left that the batch did not cover.
        const lastAttempt = cancelEndedRemoteAssignments(ticketId, ticket)
        if (lastAttempt.sends.length === 0) {
          // No ended-remote target exists, so the record can never produce a
          // send.
          orphanedRemoteTickets.delete(ticketId)
        } else {
          void Promise.all(lastAttempt.sends).then(outcomes => {
            // A lost last attempt (fail-soft 502 / rejected HTTP) keeps the
            // record so a later dispatch can resend it before its own body. A
            // delivered batch consumes the record only when a re-read of
            // committed state has no ended remote left that it did not cover.
            // A remote sticky gained while the send was in flight (a live
            // replacement) does not consume it: keeping the sticky must not
            // hide an uncovered ended remote whose own terminal cancel was
            // lost, for example A3 in the delayed-A1-cancel race.
            consumeOrphanedRemoteCancels(
              ticketId,
              lastAttempt.targets,
              outcomes.every(Boolean),
            )
          })
        }
        placement.release(ticketId)
      } catch (error) {
        log.info(`[hook] hook=mesh-release ticketId=${ticketId} error=${error instanceof Error ? error.message : String(error)}`)
      }
      notifyHarnessReleased(ticketId)
    }
    /**
     * Engine.report runs inside `Store.atomic`; the Ticket document is written
     * just before the hook, but the Store snapshot only becomes observable to
     * other commands after commit. Releasing capacity synchronously would let
     * `Harness.pump` read the pre-report snapshot (Ticket open, Assignment
     * pending/running) and start a Worker for the Ticket that just ended.
     * A microtask runs after the synchronous transaction commits.
     */
    const releaseMesh = (ticketId: string): void => {
      late.remoteResultWait?.clear(ticketId)
      queueMicrotask(() => releaseSlot(ticketId))
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
      pickNode: (ticketId, ticket) => {
        const need = requiredMeshCapabilities(baseEnv)
        const nodeId = placement.pickNode(ticketId, need)
        if (nodeId) {
          metrics.increment('mesh.assigned')
          // Local placement chosen (the returned id is the in-process node).
          // The Ticket will not claim a remote sticky slot, so start the
          // historical ended-remote cancels now instead of waiting for the
          // local replacement to end. Fail-soft and voided; a later different
          // Ticket dispatched to that node orders its body after them.
          if (!placement.isRemote(nodeId)) cancelEndedRemoteAssignments(ticketId, ticket)
        } else if (!placement.remoteHasTicket(ticketId)) {
          // Queued for a local slot: the replacement will still be local, so
          // start the same cancels early rather than at its eventual end.
          cancelEndedRemoteAssignments(ticketId, ticket)
        }
        return nodeId
      },
      isRemoteNode: nodeId => placement.isRemote(nodeId),
      dispatchRemote: async (ticket, node) => {
        // Cancel targets this dispatch has already attempted, keyed by owning
        // Ticket + Assignment. The drain below may start a *new* orphan that
        // appeared while the body was held, but a target this dispatch already
        // tried (and lost) must not be retried here: the record stays for a
        // later Ticket/retry, and a failing endpoint must not spin the drain.
        const attemptedCancelTargets = new Set<string>()
        // A different Ticket's local replacement may have started cancels for
        // ended remote Assignments this Worker still holds; the fail-soft send
        // can have been lost. Re-send them now (tracked under the owning
        // Ticket), so the cross-Ticket wait below holds this body until they
        // settle. This is not a capacity barrier: only the wire body waits and
        // only when a recorded orphan targets this node.
        resendOrphanedRemoteCancels(node, ticket.id, attemptedCancelTargets)
        // The dispatching Ticket is not a drive-by: it is being actively
        // relaunched. If its own lost terminal cancel already settled before
        // this retry, there is no in-flight batch for that target and no
        // barrier, so resend its uncovered ended remotes on this node now. Only
        // a target whose own cancel is still in flight is left to the 2a2de80
        // tradeoff; another ended Assignment's settled lost cancel on this same
        // Ticket is still resent.
        const ownResends = resendOwnOrphanedRemoteCancels(
          node,
          ticket.id,
          attemptedCancelTargets,
        )
        // Recovery/retry replacement: the Assignment is already placed (so the
        // sticky slot is kept), but the Worker must receive the superseded
        // Assignment's fail-soft cancel before this body. Consume the gate once.
        const barrier = remoteDispatchBarriers.get(ticket.id)
        if (barrier) {
          remoteDispatchBarriers.delete(ticket.id)
          await barrier
        }
        // Hold this body until the new same-Ticket resends above settle, so the
        // cancel is no later than the body. Already-in-flight same-Ticket
        // batches were not started here and are not awaited (2a2de80).
        if (ownResends.length > 0) await Promise.all(ownResends)
        // The per-Ticket gate above only covers this Ticket's own cancels. A
        // *different* Ticket may have just ended (in this process, or before a
        // restart) and its fail-soft cancel to this same node may still be in
        // flight. With spare worker capacity the new body would otherwise reach
        // the worker while it still holds the old Assignment. Hold only this
        // body; placement and the keep-vs-release settle path already ran.
        //
        // A Ticket can also end *while* such a wait holds this body, and its
        // fail-soft terminal cancel can start and be lost (502) during the wait.
        // The start-of-dispatch resend ran before that cancel existed, so it
        // could not see the new orphan; the wait then observes the failed send
        // settle and returns. Drain after *every* wait: re-run the resends for
        // targets this dispatch has not already attempted and hold the body
        // until those new sends (and any still-in-flight other-Ticket sends)
        // settle. A pass that starts nothing ends the drain, so a cancel this
        // dispatch already tried and lost is never retried here — the record is
        // kept for a later Ticket/retry (existing policy), not an in-dispatch
        // delivery loop. The same-Ticket resend skips only a target whose own
        // cancel is already in flight to this node (2a2de80); a settled lost
        // sibling cancel on this node is still resent here.
        for (;;) {
          await settleRemoteCancelSendsToNode(node, ticket.id)
          const resends = [
            ...resendOrphanedRemoteCancels(node, ticket.id, attemptedCancelTargets),
            ...resendOwnOrphanedRemoteCancels(node, ticket.id, attemptedCancelTargets),
          ]
          if (resends.length === 0) break
          await Promise.all(resends)
        }
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
          const status = delivery?.status ?? 'none'
          log.info(`[mesh] remote dispatch failed ticketId=${ticket.id} node=${node} status=${status}`)
          // The send is asynchronous: a result may have been applied while it
          // was awaiting, or recovery may have replaced the Assignment.
          // `Assignments.report` always mutates the *latest* Assignment, so a
          // late failure for a replaced Assignment must not report at all.
          const current = store.getDoc<Ticket>('ticket', ticket.id)
          const armed = current?.assignments.find(item => item.id === assignment.id)
          const latest = current?.assignments.at(-1)
          const skipReason = !current
            ? 'missing-ticket'
            : current.ended
              ? 'ticket-ended'
              : latest?.id !== assignment.id
                ? 'assignment-replaced'
                : armed?.state === 'ended'
                  ? 'assignment-ended'
                  : undefined
          if (skipReason) {
            // A newer Assignment may already own this ticket's remote
            // reservation: sticky placement keeps the slot, so a replacement
            // that has claimed the node or started work must not lose capacity
            // to this stale failed send.
            const liveReplacement = current !== undefined
              && !current.ended
              && latest !== undefined
              && latest.id !== assignment.id
              && latest.state !== 'ended'
              && (latest.state === 'running' || latest.node !== undefined || latest.startedAt !== undefined)
              && placement.remoteHasTicket(ticket.id)
            if (liveReplacement) {
              log.info(
                `[mesh] remote dispatch failed kept slot ticketId=${ticket.id} assignmentId=${assignment.id} replacementId=${latest?.id} reason=live-replacement`,
              )
              // The wait is keyed by ticketId, so clearing here would disarm a
              // live replacement that already armed its own result wait for the
              // same ticket. But leaving the slot unarmed is worse: a
              // replacement that has not armed yet would keep the sticky slot
              // forever with no recovery timer. Transfer the wait onto the
              // replacement, like the stale-timeout keep-slot path.
              if (latest) {
                if (remoteResultTimeoutMs > 0) {
                  log.info(
                    `[mesh] remote result wait armed ticketId=${ticket.id} assignmentId=${latest.id}`,
                  )
                }
                late.remoteResultWait?.arm(ticket.id, latest.id)
              }
              return
            }
            placement.release(ticket.id)
            late.remoteResultWait?.clear(ticket.id)
            return
          }
          // The Harness already marked the Assignment started and placed. The
          // transport leaves the sticky reservation to the caller, but nothing
          // will ever report a result, so end the Assignment here through the
          // same path as the remote result timeout. `deliver: false` keeps the
          // Ticket open so it can retry with a new Assignment.
          try {
            engine.report(ticket.id, {
              kind: 'failed',
              text: `remote dispatch failed status=${status}`,
              deliver: false,
            })
          } catch (error) {
            log.info(
              `[mesh] remote dispatch report failed ticketId=${ticket.id} error=${error instanceof Error ? error.message : String(error)}`,
            )
          }
          placement.release(ticket.id)
          late.remoteResultWait?.clear(ticket.id)
          return
        }
        // Dispatch is asynchronous. A result may have been applied while the
        // send was awaiting, or recovery may have replaced the Assignment.
        // Arming now would later time out work that already finished (or a
        // different, later Assignment), so re-read the committed state first.
        const current = store.getDoc<Ticket>('ticket', ticket.id)
        const armed = current?.assignments.find(item => item.id === assignment.id)
        const latest = current?.assignments.at(-1)
        const skipReason = !current
          ? 'missing-ticket'
          : current.ended
            ? 'ticket-ended'
            : latest?.id !== assignment.id
              ? 'assignment-replaced'
              : armed?.state === 'ended'
                ? 'assignment-ended'
                : undefined
        if (skipReason) {
          log.info(
            `[mesh] remote result wait skipped ticketId=${ticket.id} assignmentId=${assignment.id} reason=${skipReason}`,
          )
          // A newer Assignment may already own this ticket's remote reservation:
          // sticky placement keeps the slot, so a replacement that has claimed
          // the node or started work must not lose capacity to this stale send.
          const liveReplacement = current !== undefined
            && !current.ended
            && latest !== undefined
            && latest.id !== assignment.id
            && latest.state !== 'ended'
            && (latest.state === 'running' || latest.node !== undefined || latest.startedAt !== undefined)
            && placement.remoteHasTicket(ticket.id)
          if (liveReplacement) {
            log.info(
              `[mesh] remote result wait kept slot ticketId=${ticket.id} assignmentId=${assignment.id} replacementId=${latest?.id} reason=live-replacement`,
            )
            // A1 never armed (arm happens after a successful current dispatch).
            // A live replacement that has not yet armed its own wait would
            // otherwise hold the sticky slot forever with no recovery. Transfer
            // the wait, matching the stale-timeout and late-failed-dispatch
            // keep-slot paths.
            if (latest) {
              if (remoteResultTimeoutMs > 0) {
                log.info(
                  `[mesh] remote result wait armed ticketId=${ticket.id} assignmentId=${latest.id}`,
                )
              }
              late.remoteResultWait?.arm(ticket.id, latest.id)
            }
            return
          }
          placement.release(ticket.id)
          return
        }
        if (remoteResultTimeoutMs > 0) {
          log.info(
            `[mesh] remote result wait armed ticketId=${ticket.id} assignmentId=${assignment.id}`,
          )
        }
        late.remoteResultWait?.arm(ticket.id, assignment.id)
      },
      queueLimit: meshQueue,
      releaseNode: ticketId => releaseSlot(ticketId),
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
    // A remote node becoming eligible again (offline/stale → heartbeat) is an
    // external capacity event. Wake the Harness mesh FIFO so a parked retry or
    // enqueueWorker can pick the returned node without waiting for an unrelated
    // Worker turn to end. Extra pumps are harmless; an empty queue no-ops.
    placement.setRemoteEligibleListener(() => harness.pumpQueue())
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
      releaseSlot: ticketId => releaseSlot(ticketId),
      remoteCancelSends,
      remoteDispatchBarriers,
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
   * `(peerId, deliveryKey)`. Does not start a listener; operators mount
   * `createRemoteMeshHandler` themselves.
   */
  applyRemoteAssignmentResult(event: RemoteMeshAssignmentResultEvent): void {
    if (!this.store.isOpen) return
    const report = event.report as WorkerReport
    if (typeof report?.kind !== 'string' || typeof report?.text !== 'string') {
      this.log.info(`[mesh] remote result ignored ticketId=${event.ticketId} reason=bad-report`)
      return
    }
    // An authenticated peer may only answer for the assignment it was given.
    // Consuming the deliveryKey before this check would let any peer squat the
    // key of a ticket it does not own, so unauthorized and stale results are
    // dropped before `recordRemoteResult`.
    const ticket = this.store.getDoc<Ticket>('ticket', event.ticketId)
    const assignment = ticket?.assignments.at(-1)
    const node = assignment?.node
    const reason = !ticket
      ? 'missing-ticket'
      : !assignment || assignment.id !== event.assignmentId
        ? 'stale-assignment'
        : !node || !this.placement.isRemote(node)
          ? 'not-remote'
          : this.placement.remote?.get(node)?.peerId !== event.peerId
            ? 'peer-mismatch'
            : undefined
    if (!ticket || !assignment || reason) {
      this.log.info(
        `[mesh] remote result ignored ticketId=${event.ticketId} assignmentId=${event.assignmentId} peerId=${event.peerId} reason=unauthorized-or-stale detail=${reason}`,
      )
      return
    }
    // A timeout (or a cancel) ends the Assignment without ending the Ticket, so
    // the same Ticket can retry later. A late result for that ended Assignment
    // must not be accepted: it would consume the deliveryKey, overwrite the
    // terminal report, and a `ready`/`deliver` result could even end the Ticket.
    // The Ticket-ended path below stays idempotent for already-closed work.
    if (!ticket.ended && assignment.state === 'ended') {
      this.log.info(
        `[mesh] remote result ignored ticketId=${event.ticketId} assignmentId=${event.assignmentId} peerId=${event.peerId} reason=ended-assignment`,
      )
      return
    }
    // Idempotence is keyed on the persisted delivery marker, never on the
    // report having been attempted. A key that already landed must not re-run
    // `engine.report`: an ended Ticket rejects the second report, and a duplicate
    // must never rewrite the terminal outcome.
    if (remoteResultSeen(this.store, event.peerId, event.deliveryKey)) {
      this.log.info(`[mesh] remote result duplicate deliveryKey=${event.deliveryKey}`)
      // A duplicate is idempotent for the report, but it must not disarm a wait
      // for work that is still running: replaying an at-least-once `progress`
      // heartbeat would otherwise leave a hung Assignment with no timeout
      // recovery and its mesh slot held forever. Match the live path: only
      // finished remote work (ticket ended, assignment ended, or a pause-held
      // terminal verdict) may clear the wait.
      const recordedKind = assignment.report?.kind ?? report.kind
      const heldTerminal = REMOTE_ENDING_REPORT_KINDS.has(recordedKind) && ticket.speculative !== true
      const remoteWorkDone = Boolean(ticket.ended) || assignment.state === 'ended' || heldTerminal
      if (remoteWorkDone) {
        this.remoteResultWait?.clear(event.ticketId)
      } else {
        this.log.info(
          `[mesh] remote result duplicate kept wait ticketId=${event.ticketId} assignmentId=${event.assignmentId}`,
        )
      }
      return
    }
    // An already-ended Ticket has no live Assignment to report to. Keep
    // accepting its authorized result as an idempotent archival copy.
    if (ticket.ended) {
      recordRemoteResult(this.store, {
        ticketId: event.ticketId,
        assignmentId: event.assignmentId,
        report,
        deliveryKey: event.deliveryKey,
        peerId: event.peerId,
      })
      this.remoteResultWait?.clear(event.ticketId)
      this.log.info(
        `[mesh] remote result after ticket end ticketId=${event.ticketId} outcome=${ticket.ended.outcome}`,
      )
      this.placement.release(event.ticketId)
      return
    }
    // Report first, then persist the delivery marker. Recording before the
    // report made a throwing report permanently unretryable: the key looked
    // handled while the outcome was lost. If `engine.report` throws here, keep
    // the marker unwritten and leave the Assignment's timeout armed; that
    // handler owns recovery and slot release, and the caller sees the error so
    // it can replay the same deliveryKey.
    try {
      this.engine.report(event.ticketId, report)
    } catch (error) {
      this.log.info(
        `[mesh] remote result report failed ticketId=${event.ticketId} assignmentId=${event.assignmentId} error=${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
    recordRemoteResult(this.store, {
      ticketId: event.ticketId,
      assignmentId: event.assignmentId,
      report,
      deliveryKey: event.deliveryKey,
      peerId: event.peerId,
    })
    // A non-ending heartbeat (`progress`) leaves the Assignment running: it
    // must keep its result timeout armed and its mesh slot held, or a hung
    // remote worker is never recovered (`test/runtime-remote-result-progress`).
    // Re-read the Store after the report, because `engine.report` owns the
    // terminal transition.
    const settled = this.store.getDoc<Ticket>('ticket', event.ticketId)
    const settledAssignment = settled?.assignments.at(-1)
    const recordedKind = settledAssignment?.report?.kind ?? report.kind
    // A terminal report held by a pause does not end the Assignment while it is
    // held, but the remote work is done: resume applies the held verdict later,
    // so capacity can be freed now. A speculative silent hold is different — the
    // turn may still be live — and is excluded by `ticket.speculative`.
    const heldTerminal = REMOTE_ENDING_REPORT_KINDS.has(recordedKind) && settled?.speculative !== true
    const remoteWorkDone =
      !settled || Boolean(settled.ended) || settledAssignment?.state === 'ended' || heldTerminal
    if (remoteWorkDone) {
      this.remoteResultWait?.clear(event.ticketId)
      // When the report actually ended the latest Assignment or the Ticket,
      // `onAssignmentEnded` / `onTicketEnded` already queued `releaseMesh` →
      // `releaseSlot`. That microtask is the single owner of superseded/ended
      // remote cancels (including an older A1 whose cancel was lost) and of the
      // keep-vs-release settle policy. Clearing the sticky reservation here
      // first would make it take the local no-cancel branch and the Worker would
      // keep running A1. Only free capacity synchronously on the paths where no
      // end hook queued a release: a pause-held terminal verdict leaves the
      // Assignment open, and a vanished Ticket document has no hook to run.
      const endedByReport = Boolean(settled?.ended) || settledAssignment?.state === 'ended'
      if (!endedByReport) {
        this.placement.release(event.ticketId)
        // Freeing the slot here runs no end hook, so nothing else wakes the
        // mesh FIFO. Pump after the release so a Ticket parked because this
        // node was full can take the freed capacity instead of letting a later
        // launch jump it. Extra pumps are harmless: `pump` stops at the FIFO
        // head when no slot is free.
        this.harness.pumpQueue()
      }
      this.log.info(`[mesh] remote result applied ticketId=${event.ticketId} assignmentId=${event.assignmentId}`)
      return
    }
    this.log.info(
      `[mesh] remote progress kept wait ticketId=${event.ticketId} assignmentId=${event.assignmentId}`,
    )
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
    // A fresh process has an empty sticky map. Rebuild it from persisted
    // Assignment.node before recovery ends those Assignments so `releaseSlot`
    // can send the remote cancel the dead process never sent.
    const restoredFromEnded = this.restoreRemoteStickyReservations()
    let recovered: ReturnType<Engine['recoverInterrupted']>
    try {
      recovered = this.engine.recoverInterrupted()
    } catch (error) {
      this.log.info(`[recovery] failed error=${error instanceof Error ? error.message : String(error)}`)
      return
    }
    // The previous process may have committed recovery (ended Assignment, one
    // RECOVERED prompt, one pending replacement) and died before its queued
    // `releaseSlot` sent `assignment_cancel`. `recoverInterrupted` sees no
    // running Assignment now, so it neither ends anyone nor queues that cancel
    // again. Cancel the ended remote predecessor from the restored sticky
    // reservation. Tickets recovery just ended in this `start()` already
    // queued `releaseSlot` through `releaseMesh`, so skip them to avoid a
    // duplicate cancel.
    //
    // Queue these before the launch loop: `launchRecovered` holds the
    // replacement's remote body until the Ticket's cancel sends settle, and a
    // leftover queued afterwards would not be visible to that barrier (the
    // replacement would reach the Worker before the superseded cancel).
    const newlyEnded = new Set(
      recovered.filter(outcome => !outcome.relaunchOnly).map(outcome => outcome.ticketId),
    )
    for (const ticketId of restoredFromEnded) {
      if (newlyEnded.has(ticketId)) continue
      const ticket = this.store.getDoc<Ticket>('ticket', ticketId)
      // A successful report can already have ended the Ticket before the crash;
      // the lost cancel for the ended remote `latest` (and any older superseded
      // remote row) still has to go out. `leftoverRemoteCancelTarget` accepts
      // the ended latest itself when the Ticket has no older predecessor.
      if (!ticket || ticket.collab?.paused || pendingApproval(ticket)) continue
      const predecessor = this.leftoverRemoteCancelTarget(ticket)
      if (!predecessor) continue
      this.log.info(
        `[recovery] remote cancel queued ticketId=${ticketId} assignmentId=${predecessor.id} node=${predecessor.node}`,
      )
      // Run in a microtask like `releaseMesh`: recovery must return first, and
      // a crash in this same window must leave the state recoverable again.
      queueMicrotask(() => this.releaseSlot(ticketId))
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
   * The ended remote Assignment a still-open later Assignment superseded, if
   * any. `releaseSlot` targets this same predecessor, so it is what a leftover
   * restart cancel must authenticate.
   */
  private leftoverRemotePredecessor(ticket: Ticket): Assignment | undefined {
    const latest = ticket.assignments.at(-1)
    if (!latest || latest.state === 'ended') return undefined
    return ticket.assignments
      .slice(0, -1)
      .reverse()
      .find(item => item.state === 'ended' && item.node !== undefined && this.placement.isRemote(item.node))
  }

  /**
   * The older ended remote Assignment a Ticket carries when `latest` itself is
   * already ended. This is the crash window after an in-process report/timeout
   * (or a successful report ending the Ticket) queued the 30903c9 cancel for
   * every older ended remote and died before the HTTP send: `latest` was the
   * ended row, so once the process is gone neither recovery nor
   * `leftoverRemotePredecessor` sees a later open Assignment to justify a
   * cancel. The persisted older ended remote row is the recoverable signal.
   *
   * The Ticket may still be open (failed/timeout report) or already terminal
   * (successful report); paused and approval-held Tickets are filtered by the
   * caller like the rest of recovery.
   */
  private endedLatestRemotePredecessor(ticket: Ticket): Assignment | undefined {
    const latest = ticket.assignments.at(-1)
    if (!latest || latest.state !== 'ended') return undefined
    return ticket.assignments
      .slice(0, -1)
      .reverse()
      .find(item => item.state === 'ended' && item.node !== undefined && this.placement.isRemote(item.node))
  }

  /**
   * The ended remote `latest` row itself, when it is the only remote row a
   * Ticket carries. A Ticket whose sole Assignment is the ended remote latest
   * (a failed/timeout report that ended A1 while the Ticket stayed open, or a
   * successful report that ended A1 and the Ticket) has no superseded
   * predecessor, so `leftoverRemotePredecessor` and
   * `endedLatestRemotePredecessor` both return undefined and the crash window
   * before the queued `releaseSlot` sent A1's cancel would be lost. The ended
   * latest is itself a sufficient restore/authenticate signal: `releaseSlot`
   * already sends the cancel for an ended `latest` when it superseded nothing.
   */
  private endedLatestRemoteAssignment(ticket: Ticket): Assignment | undefined {
    const latest = ticket.assignments.at(-1)
    if (!latest || latest.state !== 'ended') return undefined
    if (latest.node === undefined || !this.placement.isRemote(latest.node)) return undefined
    return latest
  }

  /**
   * The remote Assignment a leftover restart cancel must authenticate: the
   * older superseded ended predecessor when one exists, otherwise the ended
   * remote `latest` itself. A non-undefined value is the signal to queue
   * `releaseSlot`, which sends `latest` plus every superseded ended remote row.
   */
  private leftoverRemoteCancelTarget(ticket: Ticket): Assignment | undefined {
    return this.leftoverRemotePredecessor(ticket)
      ?? this.endedLatestRemotePredecessor(ticket)
      ?? this.endedLatestRemoteAssignment(ticket)
  }

  /**
   * Rebuild the remote sticky map from persisted Assignment.node. Startup
   * recovery on a new Runtime otherwise has no reservation, so `releaseSlot`
   * takes the local branch and the worker that still runs the interrupted
   * Assignment is never told to stop (ADR-004 restart path). Only in-memory
   * remote placement is restored: the in-process worker died with the process,
   * and only a remote peer needs a cancel. This trusts persisted truth and
   * intentionally skips `pick`/eligibility so a now-stale peer is still
   * cancelled (the cancel send stays fail-soft). Paused and approval-held
   * Tickets are skipped as well. A terminal Ticket is only considered for the
   * ended-latest lost-cancel window below, never for a live running placement.
   *
   * Returns the Tickets whose reservation was rebuilt from an already-ended
   * remote Assignment rather than a running one. Two crash windows leave that
   * row behind: recovery ended the predecessor but died before the queued
   * `releaseSlot` sent its cancel (a later open Assignment exists), or the
   * process itself ended `latest`/the Ticket through a report and died before
   * its queued cancels went out (no later open Assignment exists). Both must
   * still send the lost cancel on this `start()`.
   */
  private restoreRemoteStickyReservations(): Set<string> {
    const restoredFromEnded = new Set<string>()
    for (const ticket of this.store.listDocs<Ticket>('ticket')) {
      if (ticket.collab?.paused || pendingApproval(ticket)) continue
      // Only an open Ticket can still own a live placement; a terminal Ticket
      // has no running Assignment to rebuild from.
      if (!ticket.ended) {
        for (const assignment of ticket.assignments) {
          if (assignment.state !== 'running' || !assignment.node) continue
          if (!this.placement.isRemote(assignment.node)) continue
          if (!this.placement.restoreRemoteTicket(ticket.id, assignment.node)) continue
          this.log.info(
            `[recovery] remote reservation restored ticketId=${ticket.id} assignmentId=${assignment.id} node=${assignment.node}`,
          )
        }
      }
      // A crash in the window after recovery committed A1 `ended` but before
      // the queued `releaseSlot` sent its cancel leaves an ended remote
      // predecessor with a later open Assignment and no running one. The same
      // lost-cancel window exists when `latest` itself is the ended row (an
      // in-process failed/timeout report, or a successful report that ended the
      // Ticket), including when that ended latest is the Ticket's only
      // Assignment. Rebuild sticky from that target too so the next
      // `releaseSlot` can reach the worker that still holds it. `bind` stays
      // idempotent and never clobbers a reservation bound to a different node.
      const predecessor = this.leftoverRemoteCancelTarget(ticket)
      if (!predecessor?.node) continue
      if (!this.placement.restoreRemoteTicket(ticket.id, predecessor.node)) continue
      restoredFromEnded.add(ticket.id)
      this.log.info(
        `[recovery] remote reservation restored ticketId=${ticket.id} assignmentId=${predecessor.id} node=${predecessor.node} state=ended`,
      )
    }
    return restoredFromEnded
  }

  /**
   * Relaunch one recovered Ticket without letting a failure abort the others
   * or surface as an unhandled rejection. A launch failure changes no state:
   * the replacement stays `pending`, so a later restart can relaunch it.
   *
   * The launch itself still runs synchronously, so recovery stays synchronous
   * and a crash right after `start()` leaves the replacement pending. Only the
   * replacement's *remote assignment body* is held behind a dispatch barrier
   * until every fail-soft `assignment_cancel` send for a superseded ended
   * Assignment on this Ticket has settled. The Assignment is placed before
   * that wait, so the existing keep-vs-release settle policy still sees a live
   * replacement and keeps the sticky slot. A Worker that still holds the old
   * Assignment is therefore told to stop before the new body reaches it.
   */
  private launchRecovered(ticketId: string, ticket: Ticket): void {
    const failed = (error: unknown): void => {
      this.log.info(
        `[recovery] launch failed ticketId=${ticketId} error=${error instanceof Error ? error.message : String(error)}`,
      )
    }
    this.setRemoteDispatchBarrier(ticketId, this.settleRemoteCancelSends(ticketId))
    try {
      void this.harness.launch(ticket).catch(failed)
    } catch (error) {
      failed(error)
    }
  }

  /**
   * Hold the next remote assignment body for this Ticket until `barrier`
   * settles. Dispatch consumes the barrier; if the replacement is placed
   * locally (or never dispatches) the entry simply expires.
   */
  private setRemoteDispatchBarrier(ticketId: string, barrier: Promise<void>): void {
    this.remoteDispatchBarriers.set(ticketId, barrier)
    const expire = (): void => {
      if (this.remoteDispatchBarriers.get(ticketId) === barrier) {
        this.remoteDispatchBarriers.delete(ticketId)
      }
    }
    void barrier.then(expire, expire)
  }

  /**
   * Wait until every remote cancel send already in flight (or queued behind a
   * `releaseSlot` microtask) for this Ticket has settled. Sends are fail-soft:
   * an unregistered, ineligible, or offline node settles without throwing, so
   * a launch never hangs on a cancel that cannot be delivered. No in-flight
   * send means no added delay. `skip` excludes batches already in flight when a
   * caller only wants to wait for sends its own yield is about to start.
   */
  private async settleRemoteCancelSends(
    ticketId: string,
    skip?: ReadonlySet<Promise<void>>,
  ): Promise<void> {
    // `releaseMesh` queues `releaseSlot` as a microtask; on this tick the send
    // may not be registered yet. Yield once so those microtasks start their
    // sends before deciding there is nothing to wait for.
    await Promise.resolve()
    for (;;) {
      const pending = [...(this.remoteCancelSends.get(ticketId) ?? [])]
        .filter(batch => !skip?.has(batch))
      if (pending.length === 0) return
      await Promise.allSettled(pending)
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
    if (ticket && !ticket.ended) {
      // An in-process end (report/timeout) may leave a superseded remote cancel
      // queued behind a `releaseSlot` microtask. Do not put the new Assignment
      // on a Worker before that send has at least started: the barrier flushes
      // the queue and holds the body until sends that begin now settle.
      //
      // Sends already in flight when `retry` was requested are deliberately not
      // awaited. They are owned by the keep-vs-release settle path, and blocking
      // a genuine relaunch on a slow (or held) cancel would strand the
      // replacement instead of letting it claim the slot the settle path keeps.
      const alreadySending = new Set(this.remoteCancelSends.get(ticketId) ?? [])
      this.setRemoteDispatchBarrier(
        ticketId,
        this.settleRemoteCancelSends(ticketId, alreadySending),
      )
      await this.harness.launch(ticket)
    }
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

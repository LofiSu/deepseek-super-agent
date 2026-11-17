import { APPROVAL_ANSWERS } from '../core/approval-card.ts'
import { approvalActionId } from '../core/collab.ts'
import {
  activeAssignmentId,
  beginDelegateOperation,
  finishDelegateOperation,
} from '../core/external-effects.ts'
import { ticketStage } from '../core/stage.ts'
import {
  fillAction,
  sanitizeFillLabel,
  type FillField,
  type FillKind,
  type FillTarget,
  type FillVault,
} from '../env/fill-vault.ts'
import { redactUnknown } from '../env/sanitize.ts'
import type { LocalAgentRegistry } from '../env/local-agents.ts'
import type { SkillRegistry } from '../env/skills.ts'
import { readObjectFor } from '../memory/acl.ts'
import type { Metrics } from '../metrics/metrics.ts'
import { UserError } from '../shared/errors.ts'
import type { EnvPort, EnvRunOptions, RolePortFor, RolePorts } from '../shared/ports.ts'
import type { ApprovalRequest, Disposition, Role, Ticket } from '../shared/types.ts'
import { settleSpeculation, visibleTickets } from '../speculate/index.ts'
import type { ToolCall, ToolSpec } from './model.ts'
import type { McpToolSourceLike } from './mcp.ts'
import { routerOwnerShard, routerSessionId, workerSessionId } from './session.ts'
import type { Store } from '../store/sqlite.ts'
import { MAX_TEAM_MEMBERS, type TeamRegistry } from './team.ts'

export interface ToolSession {
  sessionId: string
  role: Role
  ticketId?: string
}

/** Role-discriminated tool context. Workers receive WorkerPorts, never the Engine. */
export type ToolContext = {
  [R in Role]: {
    sessionId: string
    role: R
    ticketId?: string
    ports: RolePortFor<R>
  }
}[Role]

export interface ToolDeps {
  store: Store
  ports: RolePorts
  env: EnvPort
  metrics: Metrics
  redact: (text: string) => string
  log: (line: string) => void
  scheduleJob: (job: { id: string; sessionId: string; ticketId: string }) => void
  routerTurn: (prompt: string) => Promise<void>
  /** Append a nudge to the worker session journal (same effect as Watchdog.nudge). */
  nudge?: (sessionId: string, ticketId: string) => void
  teams?: TeamRegistry
  /** External MCP servers. Worker-only: the Router and Watchdog keep their surface. */
  mcp?: McpToolSourceLike
  /** Owner-configured local specialist agents. Absent means delegation is unavailable. */
  localAgents?: LocalAgentRegistry
  /** Owner-authored playbooks. Absent means read_skill is unavailable. */
  skills?: SkillRegistry
  /**
   * Fill-only vault and form adapter. Absent means the vault tools do not
   * exist; a vault without a target can list entries but cannot fill.
   */
  fill?: { vault: FillVault; target?: FillTarget }
}

interface ToolDef extends ToolSpec {
  roles: Role[]
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>
}

type ToolRun<R extends Role> = (
  args: Record<string, unknown>,
  ctx: Extract<ToolContext, { role: R }>,
) => Promise<unknown>

const schema = (properties: Record<string, { type: string; description?: string }> = {}): ToolSpec['parameters'] => ({
  type: 'object',
  properties,
  additionalProperties: true,
})

function guard<R extends Role>(role: R, name: string, run: ToolRun<R>): ToolDef['run'] {
  return (args, ctx) => {
    if (ctx.role !== role) throw new UserError(`tool ${name} is not available to ${ctx.role}`)
    return run(args, ctx as Extract<ToolContext, { role: R }>)
  }
}

export class ToolRegistry {
  private readonly tools: ToolDef[]
  private readonly redact: (text: string) => string

  constructor(private readonly deps: ToolDeps) {
    this.redact = deps.redact
    const { store, log, metrics } = deps
    this.tools = [
      listTasks(store),
      ...mainAgentTools(deps.ports.router, { store, log }),
      ...executorTools(deps.ports.worker, {
        store,
        env: deps.env,
        log,
        scheduleJob: deps.scheduleJob,
        routerTurn: deps.routerTurn,
        teams: deps.teams,
        fill: deps.fill,
      }),
      ...watchdogTools(deps.ports.watchdog, { env: deps.env, log, metrics, nudge: deps.nudge }),
      ...(deps.localAgents ? localAgentTools(deps.localAgents, store, log) : []),
      ...(deps.skills ? skillTools(deps.skills) : []),
    ]
  }

  async specsFor(role: Role): Promise<ToolSpec[]> {
    const specs = this.tools.filter(tool => tool.roles.includes(role)).map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }))
    // MCP tools are external capabilities for Workers. The Router decides and
    // the Watchdog fails stuck work; neither may reach a third-party server.
    if (role === 'worker' && this.deps.mcp) specs.push(...await this.deps.mcp.specs())
    return specs
  }

  async invoke(call: ToolCall, session: ToolSession): Promise<unknown> {
    if (call.name.startsWith('mcp__')) {
      if (session.role !== 'worker' || !this.deps.mcp) {
        throw new UserError(`tool ${call.name} is not available to ${session.role}`)
      }
      return redactUnknown(await this.deps.mcp.invoke(call.name, call.args), this.redact)
    }
    const tool = this.tools.find(item => item.name === call.name)
    if (!tool || !tool.roles.includes(session.role)) {
      throw new UserError(`tool ${call.name} is not available to ${session.role}`)
    }
    return redactUnknown(await tool.run(call.args, this.context(session)), this.redact)
  }

  /** Release external MCP server processes. Safe when none are configured. */
  async close(): Promise<void> {
    await this.deps.mcp?.close()
  }

  private context(session: ToolSession): ToolContext {
    if (session.role === 'router') return { ...session, role: 'router', ports: this.deps.ports.router }
    if (session.role === 'worker') return { ...session, role: 'worker', ports: this.deps.ports.worker }
    return { ...session, role: 'watchdog', ports: this.deps.ports.watchdog }
  }
}

function listTasks(store: Store): ToolDef {
  return {
    name: 'list_tasks',
    description: 'List tickets and their stages.',
    parameters: schema(),
    roles: ['router', 'watchdog'],
    run: async () => visibleTickets(store.listDocs<Ticket>('ticket')).map(ticket => ({
      id: ticket.id,
      title: ticket.title,
      stage: ticketStage(ticket),
      speculative: ticket.speculative,
    })),
  }
}

/**
 * Shard arbitration (P2-2): the first shard in `Disposition.shards` is the
 * ticket's reply owner. Every matching shard runs its own Router session, but
 * only that session may speak to the user or end the ticket, so a trigger has
 * at most one terminal Router decision and one reply path.
 *
 * A call that names a trigger is resolved from that trigger's Disposition, not
 * from the supplied ticket's origin. When both ids are present they must agree;
 * otherwise a session could borrow another trigger's ownership. Missing ticket
 * or disposition is fail-closed because every Ticket is created with an origin
 * trigger and every admitted trigger has a Disposition.
 */
function assertShardOwner(
  store: Store,
  sessionId: string,
  call: { ticketId?: string; triggerId?: string },
): void {
  const ticket = call.ticketId ? store.getDoc<Ticket>('ticket', call.ticketId) : undefined
  if (call.ticketId && !ticket) throw new UserError(`unknown ticket ${call.ticketId}`)
  if (call.triggerId && ticket && ticket.originTriggerId !== call.triggerId) {
    throw new UserError(
      `trigger ${call.triggerId} does not belong to ticket ${call.ticketId}; `
      + 'refusing cross-trigger shard ownership',
    )
  }
  const dispositionKey = call.triggerId ?? ticket?.originTriggerId
  if (!dispositionKey) {
    // A ticket-scoped call without an origin is not a known path: Tickets.create
    // always sets originTriggerId. Fail closed instead of falling back to default.
    if (call.ticketId) {
      throw new UserError(`ticket ${call.ticketId} has no origin trigger; cannot resolve shard owner`)
    }
    return
  }
  const disposition = store.getDoc<Disposition>('disposition', dispositionKey)
  if (!disposition) {
    throw new UserError(`no disposition for trigger ${dispositionKey}; cannot resolve shard owner`)
  }
  // A direct chat runs in its own thread Router session, not the disposition
  // shard, so ownership must follow the same rule the Harness used to run it.
  const owner = routerSessionId(
    ticket ? routerOwnerShard(ticket, disposition.shards?.[0]) : disposition.shards?.[0],
  )
  if (sessionId !== owner) {
    throw new UserError(
      `router shard session ${sessionId} does not own ticket ${call.ticketId ?? '-'} (owner=${owner}); `
      + 'only the first matching shard may reply or decide',
    )
  }
}

/** Main Agent tools close over Route-level ports. That is the only session allowed to speak. */
function mainAgentTools(
  ports: RolePortFor<'router'>,
  deps: { store: Store; log: (line: string) => void },
): ToolDef[] {
  const { store, log } = deps
  return [
    {
      name: 'create_worker',
      description: 'Note a worker. The engine assignment is what actually starts it.',
      parameters: schema({ title: { type: 'string' } }),
      roles: ['router'],
      run: guard('router', 'create_worker', async args => {
        log(`[harness] create_worker noted title=${String(args.title ?? '')}`)
        return { status: 'engine-assigns' }
      }),
    },
    {
      name: 'stop_worker',
      description: 'Stop a ticket and end its running assignment.',
      parameters: schema({ ticketId: { type: 'string' } }),
      roles: ['router'],
      run: guard('router', 'stop_worker', async (args, ctx) => {
        const ticketId = String(args.ticketId ?? '')
        assertShardOwner(store, ctx.sessionId, { ticketId })
        // Actually end the work; a log line alone told the model a lie.
        ports.stop(ticketId, 'router stop_worker')
        log(`[harness] stop_worker ticketId=${ticketId}`)
        return { stopped: true, ticketId }
      }),
    },
    {
      name: 'reply_user',
      description: 'Send a user-facing reply to the Thread that produced the input.',
      parameters: schema({
        ticketId: { type: 'string' },
        text: { type: 'string' },
        purpose: { type: 'string' },
        thread: { type: 'string', description: 'Thread key (source:id). Defaults to the Ticket channel.' },
      }),
      roles: ['router'],
      run: guard('router', 'reply_user', async (args, ctx) => {
        const ticketId = String(args.ticketId ?? '')
        assertShardOwner(store, ctx.sessionId, { ticketId })
        const text = String(args.text ?? '')
        const purpose = String(args.purpose ?? 'result')
        const thread = typeof args.thread === 'string' && args.thread ? args.thread : undefined
        ports.reply(ticketId, text, purpose, thread)
        return { sent: true, ticketId, purpose, thread: thread ?? null }
      }),
    },
    {
      name: 'subscribe_worker',
      description: 'Subscribe a ticket to a thread. contextOnly=true grants context but no follow-up bypass.',
      parameters: schema({
        ticketId: { type: 'string' },
        thread: { type: 'string' },
        contextOnly: { type: 'boolean' },
      }),
      roles: ['router'],
      run: guard('router', 'subscribe_worker', async args => {
        ports.subscribe(String(args.ticketId), String(args.thread), { contextOnly: args.contextOnly === true })
        return { subscribed: true, contextOnly: args.contextOnly === true }
      }),
    },
    {
      name: 'unsubscribe_worker',
      description: 'Stop a ticket from following a thread. Does not requeue a trigger; use handback for that.',
      parameters: schema({ ticketId: { type: 'string' }, thread: { type: 'string' }, reason: { type: 'string' } }),
      roles: ['router'],
      run: guard('router', 'unsubscribe_worker', async args => {
        const ticketId = String(args.ticketId ?? '')
        const thread = String(args.thread ?? '')
        const removed = ports.unsubscribe(ticketId, thread, String(args.reason ?? 'router-unsubscribe'))
        return { removed, ticketId, thread }
      }),
    },
    {
      name: 'assess_trigger',
      description:
        'Router veto for a ticket the Gate already accepted. kind=stop ends it before the Worker starts; kind=unavailable records an assessor outage.',
      parameters: schema({
        triggerId: { type: 'string' },
        ticketId: { type: 'string' },
        kind: { type: 'string' },
        reason: { type: 'string' },
      }),
      roles: ['router'],
      run: guard('router', 'assess_trigger', async (args, ctx) => {
        const triggerId = String(args.triggerId ?? '')
        const kind = String(args.kind ?? '')
        const reason = String(args.reason ?? 'router-assessment')
        if (!triggerId) throw new UserError('assess_trigger needs a triggerId')
        if (kind === 'stop') {
          const ticketId = String(args.ticketId ?? '')
          if (!ticketId) throw new UserError('assess_trigger stop needs a ticketId')
          assertShardOwner(store, ctx.sessionId, { ticketId, triggerId })
          const decision = ports.decide(triggerId, { kind: 'stop', ticketId, reason })
          log(`[harness] router veto ticketId=${ticketId} triggerId=${triggerId} reason=${reason}`)
          return { decision: decision.kind, ticketId: decision.ticketId }
        }
        if (kind === 'unavailable') {
          assertShardOwner(store, ctx.sessionId, {
            ticketId: String(args.ticketId ?? '') || undefined,
            triggerId,
          })
          const decision = ports.decide(triggerId, { kind: 'unavailable', reason })
          return { decision: decision.kind }
        }
        throw new UserError('assess_trigger kind must be stop or unavailable after the Gate accepted')
      }),
    },
  ]
}

interface WorkerToolDeps {
  store: Store
  env: EnvPort
  log: (line: string) => void
  scheduleJob: (job: { id: string; sessionId: string; ticketId: string }) => void
  routerTurn: (prompt: string) => Promise<void>
  teams?: TeamRegistry
  fill?: { vault: FillVault; target?: FillTarget }
}

type FillTools = NonNullable<WorkerToolDeps['fill']>

const ALL_FILL_FIELDS: readonly FillField[] = ['username', 'password', 'number', 'expiry', 'cvc', 'holder']

function parseFillFields(raw: unknown, available: readonly FillField[]): FillField[] {
  let values: unknown[]
  if (raw == null || raw === '') values = []
  else if (Array.isArray(raw)) values = raw
  else {
    const text = String(raw).trim()
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text) as unknown
        if (!Array.isArray(parsed)) throw new Error('not an array')
        values = parsed
      } catch {
        throw new UserError('fields must be a JSON array or comma-separated names')
      }
    } else {
      values = text.split(',').map(item => item.trim()).filter(Boolean)
    }
  }
  const fields: FillField[] = []
  for (const value of values) {
    const field = String(value).trim() as FillField
    if (!ALL_FILL_FIELDS.includes(field)) throw new UserError(`unknown fill field ${field}`)
    if (!available.includes(field)) throw new UserError(`this entry has no ${field} field`)
    if (!fields.includes(field)) fields.push(field)
  }
  return fields.length ? fields : [...available]
}

function ticketForWorker(store: Store, ctx: ToolContext & { role: 'worker' }): Ticket {
  if (!ctx.ticketId) throw new UserError('this tool needs a ticket')
  const ticket = store.getDoc<Ticket>('ticket', ctx.ticketId)
  if (!ticket) throw new UserError(`unknown ticket ${ctx.ticketId}`)
  if (ticket.ended) throw new UserError(`ticket ${ctx.ticketId} has ended (${ticket.ended.outcome})`)
  return ticket
}

/**
 * A fill only runs against the exact action the owner approved. The Worker
 * cannot name an approval it did not request, and a decision bound to another
 * action text does not match.
 */
function requireApprovedFillAction(
  ticket: Ticket,
  approvalId: string,
  action: string,
): ApprovalRequest {
  if (!approvalId.trim()) throw new UserError('fill needs the id of an approved request')
  const approval = ticket.collab?.approvals?.find(item => item.id === approvalId)
  if (!approval) throw new UserError(`unknown approval ${approvalId} on ticket ${ticket.id}`)
  if (approval.status !== 'approved') {
    throw new UserError(`approval ${approvalId} is ${approval.status}; owner approval is required before a fill`)
  }
  if (approval.usedAt) {
    throw new UserError(`approval ${approvalId} was already used for a fill; request a new approval`)
  }
  const storedActionId = approval.actionId || approvalActionId(approval.action)
  if (approval.action !== action || storedActionId !== approvalActionId(action)) {
    throw new UserError(`approval ${approvalId} does not match this fill; request approval for the exact action`)
  }
  return approval
}

function fillEntryOf(fill: FillTools, entry: string): { kind: FillKind; fields: FillField[] } {
  const found = fill.vault.summary().find(item => item.name === entry)
  if (!found) throw new UserError(`unknown vault entry ${entry}`)
  return found
}

function requireFillTarget(fill: FillTools): FillTarget {
  if (!fill.target) throw new UserError('no fill target is configured; the runtime cannot type into a form')
  return fill.target
}

/** Plan a fill without touching a secret. Safe for a tool result. */
function plannedFill(fill: FillTools, entry: string, fields: readonly FillField[]): {
  kind: FillKind
  target: string
  fields: FillField[]
  action: string
  actionId: string
} {
  const target = requireFillTarget(fill)
  const label = sanitizeFillLabel(target.label)
  if (!label) throw new UserError('fill target needs a label')
  const { kind, fields: available } = fillEntryOf(fill, entry)
  const chosen = fields.length ? [...fields] : [...available]
  const action = fillAction({ entry, kind, target: label, fields: chosen })
  return { kind, target: label, fields: chosen, action, actionId: approvalActionId(action) }
}

/** Executor tools close over ExecutorPorts. reply, decide, and receive are not in this scope. */
function executorTools(ports: RolePortFor<'worker'>, deps: WorkerToolDeps): ToolDef[] {
  const { store, env, log } = deps
  return [
    {
      name: 'bash',
      description: 'Run a shell command in the worker workspace.',
      parameters: schema({ command: { type: 'string' } }),
      roles: ['worker'],
      run: guard('worker', 'bash', async (args, ctx) => {
        const mode = mutableMode(store, env, ctx)
        const result = await env.bash(ctx.sessionId, String(args.command ?? ''), mode)
        log(`[env] bash session=${ctx.sessionId} isolated=${mode.isolated} code=${result.code}`)
        return { code: result.code, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
      }),
    },
    {
      name: 'write_file',
      description: 'Write a file in the worker workspace.',
      parameters: schema({ path: { type: 'string' }, body: { type: 'string' } }),
      roles: ['worker'],
      run: guard('worker', 'write_file', async (args, ctx) => {
        const relativePath = String(args.path ?? 'notes.txt')
        const mode = mutableMode(store, env, ctx)
        const full = await env.writeFile(ctx.sessionId, relativePath, String(args.body ?? ''), mode)
        if (ctx.ticketId && !mode.isolated) store.addArtifact(ctx.ticketId, full)
        log(`[env] write_file session=${ctx.sessionId} isolated=${mode.isolated} path=${relativePath}`)
        return { path: relativePath, isolated: mode.isolated }
      }),
    },
    {
      name: 'read_file',
      description: 'Read a file in the worker workspace.',
      parameters: schema({ path: { type: 'string' } }),
      roles: ['worker'],
      run: guard('worker', 'read_file', async (args, ctx) => ({
        text: await env.readFile(ctx.sessionId, String(args.path ?? ''), readMode(store, env, ctx)),
      })),
    },
    {
      name: 'read_object',
      description: 'Recall one page of a spilled object or follow a ref from Chain of Recall. The caller ticket or session must be granted.',
      parameters: schema({
        id: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      }),
      roles: ['worker'],
      run: guard('worker', 'read_object', async (args, ctx) => {
        const offset = Number(args.offset ?? 0)
        const limit = args.limit == null ? undefined : Number(args.limit)
        const page = readObjectFor(store, String(args.id ?? ''), {
          ticketId: ctx.ticketId,
          sessionId: ctx.sessionId,
        }, {
          offset: Number.isFinite(offset) ? offset : 0,
          limit: limit != null && Number.isFinite(limit) ? limit : undefined,
        })
        log(`[memory] read_object id=${page.id} bytes=${page.text.length} total=${page.total} refs=${page.refs.length}`)
        return page
      }),
    },
    {
      name: 'report_to_router',
      description: 'Report progress. deliver=true lets the router speak.',
      parameters: schema({
        ticketId: { type: 'string' },
        text: { type: 'string' },
        deliver: { type: 'boolean' },
        kind: { type: 'string' },
      }),
      roles: ['worker'],
      run: guard('worker', 'report_to_router', async (args, ctx) => {
        // A worker may only report on the ticket its session owns. Never trust
        // the model-supplied id over the harness context.
        if (!ctx.ticketId) throw new UserError('report_to_router needs a ticket')
        const requested = args.ticketId == null ? '' : String(args.ticketId)
        if (requested && requested !== ctx.ticketId) {
          throw new UserError(`report_to_router ticketId ${requested} does not match this session`)
        }
        const ticketId = ctx.ticketId
        const deliver = args.deliver === true
        const text = String(args.text ?? '').replace(/\n/g, ' ')
        const kind = String(args.kind ?? (deliver ? 'ready' : 'progress'))
        const result = ports.report(ticketId, { kind, text, deliver })
        settleSpeculation(env, ctx.sessionId, result.verdict)
        if (result.verdict === 'discard') log(`[speculate] rollback workdir session=${ctx.sessionId}`)
        // The gate, not the model, decides whether the router may speak.
        const announced = result.verdict === 'deliver'
        const prompt = ['REPORT', `deliver=${announced ? 'true' : 'false'}`, `ticketId=${ticketId}`, `reportText=${text}`].join('\n')
        await deps.routerTurn(prompt)
        return { ...result, deliver: announced }
      }),
    },
    {
      name: 'request_approval',
      description: 'Ask the owner to approve one exact outward, destructive, or expensive action. Stops this ticket until the owner decides.',
      parameters: schema({
        action: { type: 'string', description: 'The exact action you will perform if approved, one line.' },
        reason: { type: 'string', description: 'Why it needs the owner, one short line.' },
      }),
      roles: ['worker'],
      run: guard('worker', 'request_approval', async (args, ctx) => {
        if (!ctx.ticketId) throw new UserError('request_approval needs a ticket')
        const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim()
        const action = oneLine(String(args.action ?? ''))
        if (!action) throw new UserError('request_approval needs the exact action')
        const reason = args.reason == null ? undefined : oneLine(String(args.reason)).slice(0, 300)
        const result = ctx.ports.requestApproval(ctx.ticketId, {
          action,
          ...(reason ? { reason } : {}),
        })
        const prompt = [
          'APPROVAL',
          `ticketId=${ctx.ticketId}`,
          `approvalId=${result.approvalId}`,
          `actionId=${result.actionId}`,
          `action=${action}`,
          ...(reason ? [`reason=${reason}`] : []),
          `answers=${APPROVAL_ANSWERS.join(',')}`,
          'The Worker stopped. Tell the owner the exact action and action id in one short message and wait. The card is bound to that exact action text; if it changes, a new approval is required. You cannot answer the card yourself; the owner runs ds-agent approve, deny, or dismiss.',
        ].join('\n')
        try {
          await deps.routerTurn(prompt)
        } catch (error) {
          // The approval is already persisted, and the Worker stops on it. A
          // failed question must not turn the tool result into an error; the
          // owner can still find the request with `ds-agent approvals`.
          deps.log(
            `[approval] owner question not delivered approvalId=${result.approvalId}:`
            + ` ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        return {
          approvalId: result.approvalId,
          actionId: result.actionId,
          status: result.status,
          note: 'The ticket is waiting for the owner. Do not perform the action; stop this turn.',
        }
      }),
    },
    ...(deps.fill ? fillTools(deps.fill, store, log) : []),
    {
      name: 'subscribe_thread',
      description: 'Subscribe this ticket to another thread. contextOnly means read but do not wake.',
      parameters: schema({
        thread: { type: 'string' },
        contextOnly: { type: 'boolean', description: 'Read for context; never a follow-up wake-up.' },
      }),
      roles: ['worker'],
      run: guard('worker', 'subscribe_thread', async (args, ctx) => {
        if (!ctx.ticketId) throw new UserError('subscribe_thread needs a ticket')
        ports.subscribe(ctx.ticketId, String(args.thread ?? ''), { contextOnly: args.contextOnly === true })
        return { subscribed: true, contextOnly: args.contextOnly === true }
      }),
    },
    {
      name: 'unsubscribe_thread',
      description: 'Stop this ticket from following a thread. Does not requeue a trigger; use handback for that.',
      parameters: schema({ thread: { type: 'string' }, reason: { type: 'string' } }),
      roles: ['worker'],
      run: guard('worker', 'unsubscribe_thread', async (args, ctx) => {
        if (!ctx.ticketId) throw new UserError('unsubscribe_thread needs a ticket')
        const thread = String(args.thread ?? '')
        const removed = ports.unsubscribe(ctx.ticketId, thread, String(args.reason ?? 'worker-unsubscribe'))
        return { removed, ticketId: ctx.ticketId, thread }
      }),
    },
    {
      name: 'start_job',
      description: 'Start an async job and return immediately.',
      parameters: schema({ name: { type: 'string' } }),
      roles: ['worker'],
      run: guard('worker', 'start_job', async (args, ctx) => {
        const ticketId = ctx.ticketId ?? String(args.ticketId ?? '')
        const job = store.createJob({ sessionId: ctx.sessionId, ticketId, name: String(args.name ?? 'job') })
        log(`[job] async job started jobId=${job.id} status=started`)
        deps.scheduleJob({ id: job.id, sessionId: ctx.sessionId, ticketId })
        return { status: 'started', jobId: job.id }
      }),
    },
    {
      name: 'spawn_team',
      description: 'Spawn a Worker-internal team. Members are opaque to the Router.',
      parameters: schema({
        members: { type: 'string', description: `JSON array of {name,role?} or comma-separated names (max ${MAX_TEAM_MEMBERS})` },
      }),
      roles: ['worker'],
      run: guard('worker', 'spawn_team', async (args, ctx) => {
        if (!deps.teams) throw new UserError('team registry not configured')
        const ticketId = ctx.ticketId ?? ''
        if (!ticketId) throw new UserError('spawn_team needs a ticket')
        const members = parseTeamMembers(args.members)
        const team = deps.teams.spawnTeam({ parentSessionId: ctx.sessionId, ticketId, members })
        for (const m of team.members) {
          deps.scheduleJob({ id: m.jobId, sessionId: ctx.sessionId, ticketId })
        }
        log(`[team] spawned teamId=${team.id} members=${team.members.length}`)
        return { teamId: team.id, members: team.members.map(m => ({ jobId: m.jobId, name: m.name, role: m.role })) }
      }),
    },
    {
      name: 'team_status',
      description: 'Status of a Worker-internal team.',
      parameters: schema({ teamId: { type: 'string' } }),
      roles: ['worker'],
      run: guard('worker', 'team_status', async (args, ctx) => {
        if (!deps.teams) throw new UserError('team registry not configured')
        const teamId = String(args.teamId ?? '')
        const team = ownedTeam(deps.teams, teamId, ctx)
        if (!team) return { found: false, teamId }
        return {
          found: true,
          teamId,
          completed: Boolean(team.completedAt),
          members: team.members,
          aggregate: deps.teams.aggregateReport(teamId),
        }
      }),
    },
    {
      name: 'complete_team',
      description: 'Finish a Worker-internal team, marking any running members as done.',
      parameters: schema({ teamId: { type: 'string' } }),
      roles: ['worker'],
      run: guard('worker', 'complete_team', async (args, ctx) => {
        if (!deps.teams) throw new UserError('team registry not configured')
        const teamId = String(args.teamId ?? '')
        // Never let a worker settle another worker's team.
        if (!ownedTeam(deps.teams, teamId, ctx)) return { found: false, teamId }
        const team = deps.teams.completeTeam(teamId)
        if (!team) return { found: false, teamId }
        return {
          found: true,
          teamId,
          completed: Boolean(team.completedAt),
          members: team.members,
          aggregate: deps.teams.aggregateReport(teamId),
        }
      }),
    },

    {
      name: 'stop_job',
      description: 'Stop a running job.',
      parameters: schema({ jobId: { type: 'string' } }),
      roles: ['worker'],
      run: guard('worker', 'stop_job', async args => {
        const jobId = String(args.jobId ?? '')
        if (jobId) store.completeJob(jobId, 'stopped')
        return { status: 'stopped', jobId }
      }),
    },
  ]
}

/**
 * Fill-only vault tools. They expose names, kinds, field names, and a receipt.
 * There is intentionally no read, export, or reveal tool. A fill requires an
 * owner-approved card whose exact action text matches the planned action.
 */
function fillTools(
  fill: NonNullable<WorkerToolDeps['fill']>,
  store: Store,
  log: (line: string) => void,
): ToolDef[] {
  return [
    {
      name: 'list_vault_entries',
      description: 'List fill-only vault entry names, kinds, and usable field names. Never returns values.',
      parameters: schema(),
      roles: ['worker'],
      run: guard('worker', 'list_vault_entries', async () => ({
        entries: fill.vault.summary(),
        target: fill.target?.label ?? null,
      })),
    },
    {
      name: 'prepare_fill',
      description: 'Plan one credential or card fill without touching a secret. Returns the exact action text to pass to request_approval.',
      parameters: schema({
        entry: { type: 'string', description: 'Vault entry name from list_vault_entries.' },
        fields: { type: 'string', description: 'Optional JSON array or comma-separated field names.' },
      }),
      roles: ['worker'],
      run: guard('worker', 'prepare_fill', async args => {
        const entry = String(args.entry ?? '').trim()
        if (!entry) throw new UserError('prepare_fill needs an entry')
        const { fields: available } = fillEntryOf(fill, entry)
        const fields = parseFillFields(args.fields, available)
        const plan = plannedFill(fill, entry, fields)
        log(`[fill] prepared entry=${entry} kind=${plan.kind} fields=${plan.fields.join(',')} target=${plan.target}`)
        return { entry, ...plan }
      }),
    },
    {
      name: 'fill_credential',
      description: 'Fill one approved vault entry into the configured form. Values are never returned. Requires an approved request for the exact action.',
      parameters: schema({
        entry: { type: 'string' },
        fields: { type: 'string', description: 'Optional JSON array or comma-separated field names.' },
        approvalId: { type: 'string', description: 'Approval id that the owner approved for this exact action.' },
      }),
      roles: ['worker'],
      run: guard('worker', 'fill_credential', async (args, ctx) => {
        const ticket = ticketForWorker(store, ctx)
        const entry = String(args.entry ?? '').trim()
        if (!entry) throw new UserError('fill_credential needs an entry')
        const { fields: available } = fillEntryOf(fill, entry)
        const fields = parseFillFields(args.fields, available)
        const plan = plannedFill(fill, entry, fields)
        const approval = requireApprovedFillAction(ticket, String(args.approvalId ?? ''), plan.action)
        const target = requireFillTarget(fill)
        const receipt = await fill.vault.fill({ entry, fields: plan.fields, target })
        // One approved card authorizes one fill. Re-read before writing so a
        // concurrent decision is not overwritten.
        const fresh = store.getDoc<Ticket>('ticket', ticket.id)
        const current = fresh?.collab?.approvals?.find(item => item.id === approval.id)
        if (fresh && current) {
          current.usedAt = new Date().toISOString()
          store.putDoc('ticket', fresh.id, fresh)
        }
        log(
          `[fill] filled entry=${receipt.entry} kind=${receipt.kind} fields=${receipt.fields.join(',')}`
          + ` target=${receipt.target} approvalId=${approval.id}`,
        )
        return { ...receipt, approvalId: approval.id, actionId: plan.actionId }
      }),
    },
  ]
}

/**
 * Owner-authored playbooks. The index is already in the system prompt; this
 * tool loads one body by id. It reads documentation only: the skill cannot
 * grant a tool or widen the caller's role.
 */
function skillTools(registry: SkillRegistry): ToolDef[] {
  return [
    {
      name: 'read_skill',
      description: 'Load the full instructions for one owner-authored skill by id.',
      parameters: schema({
        skill: { type: 'string', description: 'Skill id from the Skills section of the system prompt.' },
      }),
      roles: ['router', 'worker'],
      run: async args => {
        const skill = String(args.skill ?? '').trim()
        if (!skill) throw new UserError('read_skill needs a skill id')
        return registry.read(skill)
      },
    },
  ]
}

/**
 * Owner-configured local specialist agents. The model can only name an agent
 * and supply a task; the command, argv, cwd, environment, and limits come from
 * the owner's configuration. Workers delegate; the Router may only list.
 */
function localAgentTools(
  registry: LocalAgentRegistry,
  store: Store,
  log: (line: string) => void,
): ToolDef[] {
  return [
    {
      name: 'list_local_agents',
      description: 'List local specialist agents configured on this machine.',
      parameters: schema(),
      roles: ['router', 'worker'],
      run: async () => ({ agents: registry.list() }),
    },
    {
      name: 'delegate_agent',
      description: 'Run a configured local specialist agent on one self-contained task. Verify its output before reporting.',
      parameters: schema({
        agent: { type: 'string', description: 'Configured agent id; see list_local_agents.' },
        task: {
          type: 'string',
          description: 'Complete task with all context the agent needs. Must not start with "-": it is one argv entry and would be read as an option.',
        },
      }),
      roles: ['worker'],
      run: guard('worker', 'delegate_agent', async (args, ctx) => {
        const agent = String(args.agent ?? '').trim()
        const task = String(args.task ?? '')
        if (!agent) throw new UserError('delegate_agent needs an agent id')
        // A local agent runs outside the EnvPort sandbox, so it cannot be
        // isolated for speculation, and an ended ticket must not start one.
        // Like mutableMode, this is a start-time check: a run already in
        // flight is bounded by its own timeout, not cancelled on ticket end.
        const ticket = ticketOf(store, ctx)
        if (!ticket) throw new UserError('delegate_agent needs an active ticket')
        if (ticket.ended) throw new UserError(`ticket ${ticket.id} has ended (${ticket.ended.outcome})`)
        if (ticket.speculative) {
          throw new UserError('delegate_agent is unavailable to speculative workers (local agents run unsandboxed)')
        }
        const assignmentId = activeAssignmentId(ticket)
        if (!assignmentId) throw new UserError('delegate_agent needs a running assignment on the ticket')
        const now = new Date().toISOString()
        const op = beginDelegateOperation({
          store,
          ticketId: ticket.id,
          assignmentId,
          sessionId: ctx.sessionId,
          agent,
          task,
          now,
        })
        let result
        try {
          result = await registry.run(agent, task, ctx.sessionId)
        } catch (error) {
          finishDelegateOperation(store, op.id, 'failed', now, error instanceof Error ? error.message : String(error))
          throw error
        }
        finishDelegateOperation(
          store,
          op.id,
          result.code === 0 ? 'completed' : 'failed',
          now,
        )
        log(
          `[local-agent] agent=${agent} session=${ctx.sessionId} code=${result.code}`
          + ` timedOut=${result.timedOut} truncated=${result.truncated}`,
        )
        return result
      }),
    },
  ]
}

/** Watchdog tools close over WatchdogPorts. They fail stuck work; they do not speak. */
function watchdogTools(
  ports: RolePortFor<'watchdog'>,
  deps: {
    env: EnvPort
    log: (line: string) => void
    metrics: Metrics
    nudge?: (sessionId: string, ticketId: string) => void
  },
): ToolDef[] {
  const { env, log, metrics } = deps
  return [
    {
      name: 'nudge_worker',
      description: 'Nudge a worker that looks stuck. Appends a nudge to its session journal.',
      parameters: schema({ ticketId: { type: 'string' } }),
      roles: ['watchdog'],
      run: guard('watchdog', 'nudge_worker', async args => {
        const ticketId = String(args.ticketId ?? '')
        deps.nudge?.(workerSessionId(ticketId), ticketId)
        metrics.increment('watchdog.nudge')
        log(`[watchdog] nudge ticketId=${ticketId}`)
        return { nudged: ticketId }
      }),
    },
    {
      name: 'mark_task_failed',
      description: 'Fail a stuck task.',
      parameters: schema({ ticketId: { type: 'string' }, reason: { type: 'string' } }),
      roles: ['watchdog'],
      run: guard('watchdog', 'mark_task_failed', async args => {
        const ticketId = String(args.ticketId ?? '')
        const result = ports.fail(ticketId, String(args.reason ?? 'watchdog: stuck'))
        const sessionId = workerSessionId(ticketId)
        settleSpeculation(env, sessionId, result.verdict)
        if (result.verdict === 'discard') log(`[speculate] rollback workdir session=${sessionId}`)
        log(`[watchdog] mark_task_failed ticketId=${ticketId}`)
        return { failed: ticketId }
      }),
    },
  ]
}

/** Parse model-supplied team members and fail with a clear error, never a raw TypeError. */
function parseTeamMembers(raw: unknown): { name: string; role?: string }[] {
  const isMember = (item: unknown): boolean => (
    item !== null && typeof item === 'object' && !Array.isArray(item)
  )
  if (Array.isArray(raw)) {
    if (!raw.every(isMember)) throw new UserError('spawn_team members must be an array of {name, role?} objects')
    return raw as { name: string; role?: string }[]
  }
  if (typeof raw !== 'string') {
    throw new UserError('spawn_team members must be a JSON array or comma-separated names')
  }
  const trimmed = raw.trim()
  if (!trimmed) throw new UserError('spawn_team members must not be empty')
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new UserError('spawn_team members is not valid JSON')
    }
    if (!Array.isArray(parsed)) throw new UserError('spawn_team members must be a JSON array')
    if (!parsed.every(isMember)) {
      throw new UserError('spawn_team members must be a JSON array of {name, role?} objects')
    }
    return parsed as { name: string; role?: string }[]
  }
  return trimmed.split(',').map(name => ({ name: name.trim() })).filter(member => member.name)
}

/** A worker session may only inspect or settle teams it spawned for its own ticket. */
function ownedTeam(
  teams: TeamRegistry,
  teamId: string,
  ctx: { sessionId: string; ticketId?: string },
) {
  const team = teams.getTeam(teamId)
  if (!team || team.parentSessionId !== ctx.sessionId) return undefined
  if (ctx.ticketId && team.ticketId !== ctx.ticketId) return undefined
  return team
}

function ticketOf(store: Store, ctx: { ticketId?: string }): Ticket | undefined {
  if (!ctx.ticketId) return undefined
  return store.getDoc<Ticket>('ticket', ctx.ticketId)
}

/** Speculative mutations stay in a scratch workdir, or are refused when isolation is unavailable. */
function mutableMode(store: Store, env: EnvPort, ctx: { ticketId?: string }): EnvRunOptions {
  const ticket = ticketOf(store, ctx)
  // A worker turn can outlive its ticket (watchdog failure, human stop, discard).
  // It must not keep mutating the durable workspace after that.
  if (ticket?.ended) throw new UserError(`ticket ${ticket.id} has ended (${ticket.ended.outcome})`)
  if (!ticket?.speculative) return { isolated: false }
  // Delivery is only safe when scratch can be promoted as well as discarded.
  if (!env.discardIsolated || !env.promoteIsolated) {
    throw new UserError('speculative workers are read-only without an isolated workdir')
  }
  return { isolated: true }
}

function readMode(store: Store, env: EnvPort, ctx: { ticketId?: string }): EnvRunOptions {
  const ticket = ticketOf(store, ctx)
  return { isolated: ticket?.speculative === true && Boolean(env.discardIsolated) }
}
import { ticketStage } from '../core/stage.ts'
import { redactUnknown } from '../env/sanitize.ts'
import { readSpillFor } from '../memory/acl.ts'
import type { Metrics } from '../metrics/metrics.ts'
import { UserError } from '../shared/errors.ts'
import type { EnvPort, EnvRunOptions, RolePortFor, RolePorts } from '../shared/ports.ts'
import type { Role, Ticket } from '../shared/types.ts'
import { settleSpeculation, visibleTickets } from '../speculate/index.ts'
import type { ToolCall, ToolSpec } from './model.ts'
import { workerSessionId } from './session.ts'
import type { Store } from '../store/sqlite.ts'
import type { TeamRegistry } from './team.ts'

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
  teams?: TeamRegistry
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
      ...routerTools(deps.ports.router, { log }),
      ...workerTools(deps.ports.worker, {
        store,
        env: deps.env,
        log,
        scheduleJob: deps.scheduleJob,
        routerTurn: deps.routerTurn,
        teams: deps.teams,
      }),
      ...watchdogTools(deps.ports.watchdog, { env: deps.env, log, metrics }),
    ]
  }

  specsFor(role: Role): ToolSpec[] {
    return this.tools.filter(tool => tool.roles.includes(role)).map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }))
  }

  async invoke(call: ToolCall, session: ToolSession): Promise<unknown> {
    const tool = this.tools.find(item => item.name === call.name)
    if (!tool || !tool.roles.includes(session.role)) {
      throw new UserError(`tool ${call.name} is not available to ${session.role}`)
    }
    return redactUnknown(await tool.run(call.args, this.context(session)), this.redact)
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

/** Router tools close over RouterPorts. That is the only session allowed to speak. */
function routerTools(
  ports: RolePortFor<'router'>,
  deps: { log: (line: string) => void },
): ToolDef[] {
  const { log } = deps
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
      description: 'Ask a worker to stop.',
      parameters: schema({ ticketId: { type: 'string' } }),
      roles: ['router'],
      run: guard('router', 'stop_worker', async args => {
        log(`[harness] stop_worker ticketId=${String(args.ticketId ?? '')}`)
        return { stopped: true }
      }),
    },
    {
      name: 'reply_user',
      description: 'Send a user-facing reply through the channel adapter.',
      parameters: schema({ ticketId: { type: 'string' }, text: { type: 'string' }, purpose: { type: 'string' } }),
      roles: ['router'],
      run: guard('router', 'reply_user', async args => {
        const ticketId = String(args.ticketId ?? '')
        const text = String(args.text ?? '')
        const purpose = String(args.purpose ?? 'result')
        ports.reply(ticketId, text, purpose)
        return { sent: true, ticketId, purpose }
      }),
    },
    {
      name: 'subscribe_worker',
      description: 'Subscribe a ticket to a thread.',
      parameters: schema({ ticketId: { type: 'string' }, thread: { type: 'string' } }),
      roles: ['router'],
      run: guard('router', 'subscribe_worker', async args => {
        ports.subscribe(String(args.ticketId), String(args.thread))
        return { subscribed: true }
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
}

/** Worker tools close over WorkerPorts. reply, decide, and receive are not in this scope. */
function workerTools(ports: RolePortFor<'worker'>, deps: WorkerToolDeps): ToolDef[] {
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
      description: 'Recall one page of a spilled object. The caller ticket or session must be granted.',
      parameters: schema({
        id: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      }),
      roles: ['worker'],
      run: guard('worker', 'read_object', async (args, ctx) => {
        const offset = Number(args.offset ?? 0)
        const limit = args.limit == null ? undefined : Number(args.limit)
        const page = readSpillFor(store, String(args.id ?? ''), {
          ticketId: ctx.ticketId,
          sessionId: ctx.sessionId,
        }, {
          offset: Number.isFinite(offset) ? offset : 0,
          limit: limit != null && Number.isFinite(limit) ? limit : undefined,
        })
        log(`[memory] read_object id=${page.id} bytes=${page.text.length} total=${page.total}`)
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
        const ticketId = String(args.ticketId ?? ctx.ticketId ?? '')
        const deliver = args.deliver === true
        const text = String(args.text ?? '').replace(/\n/g, ' ')
        const kind = String(args.kind ?? (deliver ? 'ready' : 'progress'))
        const result = ports.report(ticketId, { kind, text, deliver })
        settleSpeculation(env, ctx.sessionId, result.verdict)
        if (result.verdict === 'discard') log(`[speculate] rollback workdir session=${ctx.sessionId}`)
        const prompt = ['REPORT', `deliver=${deliver ? 'true' : 'false'}`, `ticketId=${ticketId}`, `reportText=${text}`].join('\n')
        await deps.routerTurn(prompt)
        return { ...result, deliver }
      }),
    },
    {
      name: 'subscribe_thread',
      description: 'Subscribe this ticket to another thread.',
      parameters: schema({ thread: { type: 'string' } }),
      roles: ['worker'],
      run: guard('worker', 'subscribe_thread', async (args, ctx) => {
        if (!ctx.ticketId) throw new UserError('subscribe_thread needs a ticket')
        ports.subscribe(ctx.ticketId, String(args.thread ?? ''))
        return { subscribed: true }
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
        members: { type: 'string', description: 'JSON array of {name,role?} or comma-separated names' },
      }),
      roles: ['worker'],
      run: guard('worker', 'spawn_team', async (args, ctx) => {
        if (!deps.teams) throw new UserError('team registry not configured')
        const ticketId = ctx.ticketId ?? ''
        if (!ticketId) throw new UserError('spawn_team needs a ticket')
        let members: { name: string; role?: string }[] = []
        const raw = args.members
        if (typeof raw === 'string') {
          const trimmed = raw.trim()
          if (trimmed.startsWith('[')) members = JSON.parse(trimmed) as { name: string; role?: string }[]
          else members = trimmed.split(',').map(name => ({ name: name.trim() })).filter(m => m.name)
        } else if (Array.isArray(raw)) {
          members = raw as { name: string; role?: string }[]
        }
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
      run: guard('worker', 'team_status', async args => {
        if (!deps.teams) throw new UserError('team registry not configured')
        const teamId = String(args.teamId ?? '')
        const team = deps.teams.getTeam(teamId)
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
      run: guard('worker', 'complete_team', async args => {
        if (!deps.teams) throw new UserError('team registry not configured')
        const teamId = String(args.teamId ?? '')
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

/** Watchdog tools close over WatchdogPorts. They fail stuck work; they do not speak. */
function watchdogTools(
  ports: RolePortFor<'watchdog'>,
  deps: { env: EnvPort; log: (line: string) => void; metrics: Metrics },
): ToolDef[] {
  const { env, log, metrics } = deps
  return [
    {
      name: 'nudge_worker',
      description: 'Nudge a worker that looks stuck.',
      parameters: schema({ ticketId: { type: 'string' } }),
      roles: ['watchdog'],
      run: guard('watchdog', 'nudge_worker', async args => {
        const ticketId = String(args.ticketId ?? '')
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

function ticketOf(store: Store, ctx: { ticketId?: string }): Ticket | undefined {
  if (!ctx.ticketId) return undefined
  return store.getDoc<Ticket>('ticket', ctx.ticketId)
}

/** Speculative mutations stay in a scratch workdir, or are refused when isolation is unavailable. */
function mutableMode(store: Store, env: EnvPort, ctx: { ticketId?: string }): EnvRunOptions {
  const ticket = ticketOf(store, ctx)
  if (!ticket?.speculative) return { isolated: false }
  if (ticket.ended) throw new UserError('speculative assignment was discarded')
  if (!env.discardIsolated) throw new UserError('speculative workers are read-only without an isolated workdir')
  return { isolated: true }
}

function readMode(store: Store, env: EnvPort, ctx: { ticketId?: string }): EnvRunOptions {
  const ticket = ticketOf(store, ctx)
  return { isolated: ticket?.speculative === true && Boolean(env.discardIsolated) }
}
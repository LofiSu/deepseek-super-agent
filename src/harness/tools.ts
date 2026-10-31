import { ticketStage } from '../core/stage.ts'
import type { Engine } from '../core/engine.ts'
import { redactUnknown } from '../env/sanitize.ts'
import { readSpillFor } from '../memory/acl.ts'
import type { Metrics } from '../metrics/metrics.ts'
import { UserError } from '../shared/errors.ts'
import type { EnvPort, EnvRunOptions } from '../shared/ports.ts'
import type { Role, Ticket } from '../shared/types.ts'
import { settleSpeculation, visibleTickets } from '../speculate/index.ts'
import type { ToolCall, ToolSpec } from './model.ts'
import { workerSessionId } from './session.ts'
import type { Store } from '../store/sqlite.ts'

export interface ToolCtx {
  sessionId: string
  role: Role
  ticketId?: string
}

export interface ToolDeps {
  store: Store
  engine: Engine
  env: EnvPort
  metrics: Metrics
  redact: (text: string) => string
  log: (line: string) => void
  scheduleJob: (job: { id: string; sessionId: string; ticketId: string }) => void
  routerTurn: (prompt: string) => Promise<void>
}

interface ToolDef extends ToolSpec {
  roles: Role[]
  run: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>
}

const schema = (properties: Record<string, { type: string; description?: string }> = {}): ToolSpec['parameters'] => ({
  type: 'object',
  properties,
  additionalProperties: true,
})

export class ToolRegistry {
  private readonly tools: ToolDef[]
  private readonly redact: (text: string) => string

  constructor(deps: ToolDeps) {
    this.redact = deps.redact
    const { store, engine, env, log, metrics } = deps
    this.tools = [
      {
        name: 'create_worker',
        description: 'Note a worker. The engine assignment is what actually starts it.',
        parameters: schema({ title: { type: 'string' } }),
        roles: ['router'],
        run: async args => {
          log(`[harness] create_worker noted title=${String(args.title ?? '')}`)
          return { status: 'engine-assigns' }
        },
      },
      {
        name: 'stop_worker',
        description: 'Ask a worker to stop.',
        parameters: schema({ ticketId: { type: 'string' } }),
        roles: ['router'],
        run: async args => {
          log(`[harness] stop_worker ticketId=${String(args.ticketId ?? '')}`)
          return { stopped: true }
        },
      },
      {
        name: 'reply_user',
        description: 'Send a user-facing reply through the channel adapter.',
        parameters: schema({ ticketId: { type: 'string' }, text: { type: 'string' }, purpose: { type: 'string' } }),
        roles: ['router'],
        run: async args => {
          const ticketId = String(args.ticketId ?? '')
          const text = String(args.text ?? '')
          const purpose = String(args.purpose ?? 'result')
          engine.reply(ticketId, text, purpose)
          return { sent: true, ticketId, purpose }
        },
      },
      {
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
      },
      {
        name: 'subscribe_worker',
        description: 'Subscribe a ticket to a thread.',
        parameters: schema({ ticketId: { type: 'string' }, thread: { type: 'string' } }),
        roles: ['router'],
        run: async args => {
          engine.subscribe(String(args.ticketId), String(args.thread))
          return { subscribed: true }
        },
      },
      {
        name: 'bash',
        description: 'Run a shell command in the worker workspace.',
        parameters: schema({ command: { type: 'string' } }),
        roles: ['worker'],
        run: async (args, ctx) => {
          const mode = mutableMode(store, env, ctx)
          const result = await env.bash(ctx.sessionId, String(args.command ?? ''), mode)
          log(`[env] bash session=${ctx.sessionId} isolated=${mode.isolated} code=${result.code}`)
          return { code: result.code, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
        },
      },
      {
        name: 'write_file',
        description: 'Write a file in the worker workspace.',
        parameters: schema({ path: { type: 'string' }, body: { type: 'string' } }),
        roles: ['worker'],
        run: async (args, ctx) => {
          const relativePath = String(args.path ?? 'notes.txt')
          const mode = mutableMode(store, env, ctx)
          const full = await env.writeFile(ctx.sessionId, relativePath, String(args.body ?? ''), mode)
          if (ctx.ticketId && !mode.isolated) store.addArtifact(ctx.ticketId, full)
          log(`[env] write_file session=${ctx.sessionId} isolated=${mode.isolated} path=${relativePath}`)
          return { path: relativePath, isolated: mode.isolated }
        },
      },
      {
        name: 'read_file',
        description: 'Read a file in the worker workspace.',
        parameters: schema({ path: { type: 'string' } }),
        roles: ['worker'],
        run: async (args, ctx) => ({
          text: await env.readFile(ctx.sessionId, String(args.path ?? ''), readMode(store, env, ctx)),
        }),
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
        run: async (args, ctx) => {
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
        },
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
        run: async (args, ctx) => {
          const ticketId = String(args.ticketId ?? ctx.ticketId ?? '')
          const deliver = args.deliver === true
          const text = String(args.text ?? '').replace(/\n/g, ' ')
          const kind = String(args.kind ?? (deliver ? 'ready' : 'progress'))
          const result = engine.report(ticketId, { kind, text, deliver })
          settleSpeculation(env, ctx.sessionId, result.verdict)
          if (result.verdict === 'discard') log(`[speculate] rollback workdir session=${ctx.sessionId}`)
          const prompt = ['REPORT', `deliver=${deliver ? 'true' : 'false'}`, `ticketId=${ticketId}`, `reportText=${text}`].join('\n')
          await deps.routerTurn(prompt)
          return { ...result, deliver }
        },
      },
      {
        name: 'subscribe_thread',
        description: 'Subscribe this ticket to another thread.',
        parameters: schema({ thread: { type: 'string' } }),
        roles: ['worker'],
        run: async (args, ctx) => {
          if (!ctx.ticketId) throw new UserError('subscribe_thread needs a ticket')
          engine.subscribe(ctx.ticketId, String(args.thread ?? ''))
          return { subscribed: true }
        },
      },
      {
        name: 'start_job',
        description: 'Start an async job and return immediately.',
        parameters: schema({ name: { type: 'string' } }),
        roles: ['worker'],
        run: async (args, ctx) => {
          const ticketId = ctx.ticketId ?? String(args.ticketId ?? '')
          const job = store.createJob({ sessionId: ctx.sessionId, ticketId, name: String(args.name ?? 'job') })
          log(`[job] async job started jobId=${job.id} status=started`)
          deps.scheduleJob({ id: job.id, sessionId: ctx.sessionId, ticketId })
          return { status: 'started', jobId: job.id }
        },
      },
      {
        name: 'stop_job',
        description: 'Stop a running job.',
        parameters: schema({ jobId: { type: 'string' } }),
        roles: ['worker'],
        run: async args => {
          const jobId = String(args.jobId ?? '')
          if (jobId) store.completeJob(jobId, 'stopped')
          return { status: 'stopped', jobId }
        },
      },
      {
        name: 'nudge_worker',
        description: 'Nudge a worker that looks stuck.',
        parameters: schema({ ticketId: { type: 'string' } }),
        roles: ['watchdog'],
        run: async args => {
          const ticketId = String(args.ticketId ?? '')
          metrics.increment('watchdog.nudge')
          log(`[watchdog] nudge ticketId=${ticketId}`)
          return { nudged: ticketId }
        },
      },
      {
        name: 'mark_task_failed',
        description: 'Fail a stuck task.',
        parameters: schema({ ticketId: { type: 'string' }, reason: { type: 'string' } }),
        roles: ['watchdog'],
        run: async args => {
          const ticketId = String(args.ticketId ?? '')
          const result = engine.report(ticketId, { kind: 'failed', text: String(args.reason ?? 'watchdog: stuck'), deliver: false })
          settleSpeculation(env, workerSessionId(ticketId), result.verdict)
          if (result.verdict === 'discard') log(`[speculate] rollback workdir session=${workerSessionId(ticketId)}`)
          log(`[watchdog] mark_task_failed ticketId=${ticketId}`)
          return { failed: ticketId }
        },
      },
    ]
  }

  specsFor(role: Role): ToolSpec[] {
    return this.tools.filter(tool => tool.roles.includes(role)).map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }))
  }

  async invoke(call: ToolCall, ctx: ToolCtx): Promise<unknown> {
    const tool = this.tools.find(item => item.name === call.name)
    if (!tool || !tool.roles.includes(ctx.role)) throw new UserError(`tool ${call.name} is not available to ${ctx.role}`)
    return redactUnknown(await tool.run(call.args, ctx), this.redact)
  }
}

function ticketOf(store: Store, ctx: ToolCtx): Ticket | undefined {
  if (!ctx.ticketId) return undefined
  return store.getDoc<Ticket>('ticket', ctx.ticketId)
}

/** Speculative mutations stay in a scratch workdir, or are refused when isolation is unavailable. */
function mutableMode(store: Store, env: EnvPort, ctx: ToolCtx): EnvRunOptions {
  const ticket = ticketOf(store, ctx)
  if (!ticket?.speculative) return { isolated: false }
  if (ticket.ended) throw new UserError('speculative assignment was discarded')
  if (!env.discardIsolated) throw new UserError('speculative workers are read-only without an isolated workdir')
  return { isolated: true }
}

function readMode(store: Store, env: EnvPort, ctx: ToolCtx): EnvRunOptions {
  const ticket = ticketOf(store, ctx)
  return { isolated: ticket?.speculative === true && Boolean(env.discardIsolated) }
}

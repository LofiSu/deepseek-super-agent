import type { Engine } from '../core/engine.ts'
import { redactRecord } from '../env/sanitize.ts'
import type { Metrics } from '../metrics/metrics.ts'
import type { Role, Ticket, Trigger } from '../shared/types.ts'
import type { Model, ModelMessage } from './model.ts'
import { systemPrompt } from './model.ts'
import { workerSessionId, type SessionJournal } from './session.ts'
import { ToolRegistry } from './tools.ts'
import type { Store } from '../store/sqlite.ts'

export interface HarnessOptions {
  model: Model
  tools: ToolRegistry
  store: Store
  engine: Engine
  journal: SessionJournal
  metrics: Metrics
  redact: (text: string) => string
  log: (line: string) => void
  jobDelayMs: number
}

/** Async ReAct loop plus the in-process daemon that launches workers. */
export class Harness {
  private readonly chains = new Map<string, Promise<void>>()
  private inflight: Promise<void>[] = []
  private readonly running = new Set<string>()
  private readonly pendingJobs: Promise<void>[] = []
  private routerReady = false

  constructor(private readonly opts: HarnessOptions) {}

  armRouter(): void {
    if (this.routerReady) return
    this.routerReady = true
    this.opts.log('[harness] RouterSession start session=router role=router')
  }

  launch(ticket: Ticket): Promise<void> {
    const sessionId = workerSessionId(ticket.id)
    this.running.add(ticket.id)
    this.armRouter()
    this.opts.log(`[harness] dual-layer RouterSession=router WorkerSession=${sessionId} ticketId=${ticket.id}`)
    this.opts.log(`[harness] WorkerSession start session=${sessionId} ticketId=${ticket.id} role=worker`)
    if (this.running.size >= 2) {
      this.opts.log(`[harness] parallel workers=${this.running.size} sessions=${[...this.running].join(',')}`)
    }
    const assignment = ticket.assignments.at(-1)
    if (!assignment) throw new Error(`ticket ${ticket.id} has no assignment`)
    this.opts.engine.assignmentStarted(ticket.id, assignment.id, sessionId)
    const mode = ticket.speculative ? 'speculative' : 'normal'
    const task = [
      'TASK',
      `ticketId=${ticket.id}`,
      `title=${ticket.title}`,
      `mode=${mode}`,
      `thread=${ticket.threadKeys[0] ?? ''}`,
      `brief=${ticket.brief}`,
    ]
    if (ticket.spillId) task.push(`spillId=${ticket.spillId}`)
    const routerPrompt = [
      ticket.speculative ? 'SPECULATIVE' : 'TICKET_CREATED',
      `ticketId=${ticket.id}`,
      `title=${ticket.title}`,
      `mode=${mode}`,
    ].join('\n')
    const work = Promise.all([
      this.enqueue('router', () => this.run('router', 'router', undefined, routerPrompt)),
      this.enqueue(sessionId, () => this.run(sessionId, 'worker', ticket.id, task.join('\n'))),
    ]).then(() => undefined).finally(() => {
      this.running.delete(ticket.id)
    })
    return this.track(work)
  }

  deliver(ticketId: string, trigger: Trigger): Promise<void> {
    const ticket = this.opts.store.getDoc<Ticket>('ticket', ticketId)
    const mode = ticket?.speculative ? 'speculative' : 'normal'
    const lines = ['FOLLOWUP', `ticketId=${ticketId}`, `mode=${mode}`, `text=${trigger.text}`]
    const spillId = typeof trigger.meta.spillId === 'string' ? trigger.meta.spillId : ''
    if (spillId) lines.push(`spillId=${spillId}`)
    const sessionId = workerSessionId(ticketId)
    return this.track(this.enqueue(sessionId, () => this.run(sessionId, 'worker', ticketId, lines.join('\n'))))
  }

  scheduleJob(job: { id: string; sessionId: string; ticketId: string }): void {
    const done = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        try {
          if (!this.opts.store.isOpen) {
            resolve()
            return
          }
          this.opts.store.completeJob(job.id, 'succeeded')
          this.opts.log(`[job] async job finished jobId=${job.id} status=succeeded`)
          this.opts.log(`[job] completion trigger session=${job.sessionId} jobId=${job.id}`)
          const prompt = `JOB_DONE\njobId=${job.id}\nticketId=${job.ticketId}`
          const turn = this.enqueue(job.sessionId, () => this.run(job.sessionId, 'worker', job.ticketId, prompt))
          this.track(turn)
          turn.then(() => resolve(), reject)
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      }, this.opts.jobDelayMs)
    })
    this.pendingJobs.push(done)
  }

  routerTurn(prompt: string): Promise<void> {
    this.armRouter()
    return this.enqueue('router', () => this.run('router', 'router', undefined, prompt))
  }

  async watchdogTurn(): Promise<void> {
    this.opts.log('[watchdog] WatchdogSession start session=watchdog role=watchdog')
    await this.track(this.enqueue('watchdog', () => this.run(
      'watchdog',
      'watchdog',
      undefined,
      'WATCHDOG\ncheck stuck workers and database health',
    )))
  }

  async drain(): Promise<void> {
    for (let wave = 0; wave < 40; wave += 1) {
      if (this.inflight.length === 0) return
      const batch = this.inflight.splice(0, this.inflight.length)
      const results = await Promise.allSettled(batch)
      const failed = results.find(result => result.status === 'rejected')
      if (failed && failed.status === 'rejected') throw failed.reason
    }
    if (this.inflight.length > 0) throw new Error('harness drain did not settle')
  }

  async jobsSettled(): Promise<void> {
    for (let wave = 0; wave < 20; wave += 1) {
      await this.drain()
      if (this.pendingJobs.length === 0) return
      const batch = this.pendingJobs.splice(0, this.pendingJobs.length)
      await Promise.all(batch)
    }
    throw new Error('jobs did not settle')
  }

  private track(work: Promise<void>): Promise<void> {
    this.inflight.push(work)
    return work
  }

  private enqueue(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.chains.set(sessionId, next.then(() => undefined, () => undefined))
    return next
  }

  private async run(sessionId: string, role: Role, ticketId: string | undefined, prompt: string): Promise<void> {
    if (!this.opts.store.isOpen) return
    const createdAt = new Date().toISOString()
    this.opts.store.upsertSession({
      id: sessionId,
      role,
      ticketId,
      status: 'running',
      heartbeat: createdAt,
      createdAt,
    })
    try {
      await runTurn({
        model: this.opts.model,
        tools: this.opts.tools,
        journal: this.opts.journal,
        log: this.opts.log,
        metrics: this.opts.metrics,
        redact: this.opts.redact,
        session: { id: sessionId, role, ticketId },
        prompt,
      })
    } finally {
      if (this.opts.store.isOpen) {
        this.opts.store.upsertSession({
          id: sessionId,
          role,
          ticketId,
          status: 'idle',
          heartbeat: new Date().toISOString(),
          createdAt,
        })
      }
    }
  }
}

export async function runTurn(input: {
  model: Model
  tools: ToolRegistry
  journal: SessionJournal
  log: (line: string) => void
  metrics: Metrics
  redact: (text: string) => string
  session: { id: string; role: Role; ticketId?: string }
  prompt: string
  maxSteps?: number
}): Promise<void> {
  const label = input.session.role === 'router'
    ? 'RouterSession'
    : input.session.role === 'worker' ? 'WorkerSession' : 'WatchdogSession'
  const redact = input.redact
  input.log(`[harness] ${label} turn session=${input.session.id}`)
  const prompt = redact(input.prompt)
  const messages: ModelMessage[] = [
    { role: 'system', content: redact(systemPrompt(input.session.role)) },
    { role: 'user', content: prompt },
  ]
  input.journal.append(input.session.id, { role: 'user', kind: 'message', content: prompt })
  const tools = input.tools.specsFor(input.session.role)
  const maxSteps = input.maxSteps ?? 10
  for (let step = 0; step < maxSteps; step += 1) {
    input.log(`[harness] async-react step=${step} session=${input.session.id} role=${input.session.role}`)
    const started = performance.now()
    const out = await input.model.complete({ role: input.session.role, messages, tools })
    input.metrics.observeModelLatency(performance.now() - started)
    const text = redact(out.text ?? '')
    const calls = (out.toolCalls ?? []).map(toolCall => ({
      ...toolCall,
      args: redactRecord(toolCall.args, redact),
    }))
    messages.push({ role: 'assistant', content: text, toolCalls: calls })
    input.journal.append(input.session.id, { role: 'assistant', kind: 'message', content: text, toolCalls: calls })
    if (calls.length === 0) break
    for (const toolCall of calls) {
      let content: string
      try {
        const result = await input.tools.invoke(toolCall, {
          sessionId: input.session.id,
          role: input.session.role,
          ticketId: input.session.ticketId,
        })
        content = redact(JSON.stringify(result))
      } catch (error) {
        content = redact(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
      messages.push({ role: 'tool', name: toolCall.name, toolCallId: toolCall.id, content })
      input.journal.append(input.session.id, { role: 'tool', name: toolCall.name, kind: 'tool', content })
    }
  }
}

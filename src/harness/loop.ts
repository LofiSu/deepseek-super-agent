import { withSessionRole } from '../core/session-role.ts'
import { redactRecord } from '../env/sanitize.ts'
import type { Metrics } from '../metrics/metrics.ts'
import type { Role, Ticket, Trigger } from '../shared/types.ts'
import type { Model, ModelMessage } from './model.ts'
import { systemPrompt } from './model.ts'
import { workerSessionId, type JournalEntry, type SessionJournal } from './session.ts'
import { TeamRegistry } from './team.ts'
import { ToolRegistry } from './tools.ts'
import type { Store } from '../store/sqlite.ts'

export interface HarnessOptions {
  model: Model
  tools: ToolRegistry
  store: Store
  /** Host bookkeeping when a worker session starts. The harness does not hold the Engine. */
  assignmentStarted(ticketId: string, assignmentId: string, sessionId: string): void
  journal: SessionJournal
  metrics: Metrics
  redact: (text: string) => string
  log: (line: string) => void
  jobDelayMs: number
  teams?: TeamRegistry
  /** Unseen human guidance for a Router/Worker turn. Marks it injected for that audience. */
  takeGuidance?: (ticketId: string, audience: 'worker' | 'router') => string[]
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
    const held = this.pauseReason(ticket.id)
    if (held) {
      this.opts.log(`[collab] launch held ticketId=${ticket.id} reason=${held}`)
      this.opts.store.addEvent('collab.delivery_held', { ticketId: ticket.id, kind: 'launch' })
      return Promise.resolve()
    }
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
    this.opts.assignmentStarted(ticket.id, assignment.id, sessionId)
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
    const held = this.pauseReason(ticketId)
    if (held) {
      this.opts.log(`[collab] delivery held ticketId=${ticketId} triggerId=${trigger.id} reason=${held}`)
      this.opts.store.addEvent('collab.delivery_held', {
        ticketId,
        triggerId: trigger.id,
        kind: 'followup',
      })
      return Promise.resolve()
    }
    const ticket = this.opts.store.getDoc<Ticket>('ticket', ticketId)
    const mode = ticket?.speculative ? 'speculative' : 'normal'
    const lines = ['FOLLOWUP', `ticketId=${ticketId}`, `mode=${mode}`, `text=${trigger.text}`]
    const spillId = typeof trigger.meta.spillId === 'string' ? trigger.meta.spillId : ''
    if (spillId) lines.push(`spillId=${spillId}`)
    const sessionId = workerSessionId(ticketId)
    return this.track(this.enqueue(sessionId, () => this.run(sessionId, 'worker', ticketId, lines.join('\n'))))
  }

  /**
   * Continue a ticket whose pause was just cleared. Router and Worker both get a RESUME
   * turn. Unseen human guidance and follow-ups received while paused are in the prompt.
   */
  resume(ticket: Ticket): Promise<void> {
    if (ticket.ended) {
      this.opts.log(`[collab] resume refused ticketId=${ticket.id} ended=${ticket.ended.outcome}`)
      return Promise.resolve()
    }
    if (ticket.collab?.paused) {
      this.opts.log(`[collab] resume refused ticketId=${ticket.id} still-paused`)
      return Promise.resolve()
    }
    const assignment = ticket.assignments.at(-1)
    if (!assignment) throw new Error(`ticket ${ticket.id} has no assignment`)
    const sessionId = workerSessionId(ticket.id)
    const since = ticket.collab?.resumes.at(-1)?.pausedAt
    const pending = since
      ? ticket.inputs.filter(input => input.at >= since && typeof input.text === 'string')
      : []
    const mode = ticket.speculative ? 'speculative' : 'normal'
    this.running.add(ticket.id)
    this.armRouter()
    this.opts.log(
      `[harness] WorkerSession resume session=${sessionId} ticketId=${ticket.id} role=worker guidanceSince=${since ?? '-'}`,
    )
    if (assignment.state === 'pending') {
      this.opts.assignmentStarted(ticket.id, assignment.id, sessionId)
    }

    const workerPrompt = (guidance: string[]): string => {
      const lines = [
        'RESUME',
        `ticketId=${ticket.id}`,
        `title=${ticket.title}`,
        `mode=${mode}`,
        `thread=${ticket.threadKeys[0] ?? ''}`,
        `brief=${ticket.brief}`,
      ]
      if (since) lines.push(`pausedAt=${since}`)
      for (const text of guidance) lines.push(`guidance=${text}`)
      for (const input of pending) lines.push(`input=${input.text ?? ''}`)
      lines.push('Continue the interrupted task from your session history. Apply the human guidance before acting.')
      return lines.join('\n')
    }
    const routerPrompt = (guidance: string[]): string => {
      const lines = [
        'RESUME',
        `ticketId=${ticket.id}`,
        `title=${ticket.title}`,
        `mode=${mode}`,
      ]
      for (const text of guidance) lines.push(`guidance=${text}`)
      lines.push('The human resumed this paused task. Keep the acknowledgement short; leave the work to the Worker.')
      return lines.join('\n')
    }
    const guarded = (session: string, role: 'router' | 'worker', build: (guidance: string[]) => string): Promise<void> => {
      const held = this.pauseReason(ticket.id)
      if (held) {
        this.opts.log(`[collab] resume held session=${session} ticketId=${ticket.id} reason=${held}`)
        return Promise.resolve()
      }
      const guidance = this.opts.takeGuidance?.(ticket.id, role) ?? []
      return this.run(session, role, role === 'worker' ? ticket.id : undefined, build(guidance))
    }

    const work = Promise.all([
      this.enqueue('router', () => guarded('router', 'router', routerPrompt)),
      this.enqueue(sessionId, () => guarded(sessionId, 'worker', workerPrompt)),
    ]).then(() => undefined).finally(() => {
      this.running.delete(ticket.id)
    })
    return this.track(work)
  }

  scheduleJob(job: { id: string; sessionId: string; ticketId: string }): void {
    const done = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        try {
          if (!this.opts.store.isOpen) {
            resolve()
            return
          }
          const teamId = this.opts.teams?.teamIdForJob(job.id)
          if (teamId && this.opts.teams) {
            this.opts.teams.reportFromMember(job.id, 'member done', 'succeeded')
            this.opts.log(`[team] member done teamId=${teamId} jobId=${job.id}`)
            const prompt = `TEAM_MEMBER_DONE\nteamId=${teamId}\njobId=${job.id}\nticketId=${job.ticketId}\naggregate=${this.opts.teams.aggregateReport(teamId)}`
            const turn = this.enqueue(job.sessionId, () => this.run(job.sessionId, 'worker', job.ticketId, prompt))
            this.track(turn)
            turn.then(() => resolve(), reject)
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

  /**
   * Pause is read from Store on every step, so a CLI in another process can stop work.
   * Router prompts carry `ticketId=`; worker calls pass the ticket directly.
   */
  private pauseReason(ticketId?: string, prompt?: string): string | undefined {
    if (!this.opts.store.isOpen) return undefined
    const id = ticketId ?? /^ticketId=(\S+)$/m.exec(prompt ?? '')?.[1]
    if (!id) return undefined
    const ticket = this.opts.store.getDoc<Ticket>('ticket', id)
    const paused = ticket?.collab?.paused
    if (!paused) return undefined
    const reason = paused.reason ? ` reason=${paused.reason}` : ''
    return `at=${paused.at} by=${paused.by}${reason}`
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
        pause: () => this.pauseReason(ticketId, prompt),
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
  /** Return a reason to stop this turn before the next model call or tool call. */
  pause?: () => string | undefined
}): Promise<void> {
  return withSessionRole(input.session.role, () => runTurnBody(input))
}

async function runTurnBody(input: {
  model: Model
  tools: ToolRegistry
  journal: SessionJournal
  log: (line: string) => void
  metrics: Metrics
  redact: (text: string) => string
  session: { id: string; role: Role; ticketId?: string }
  prompt: string
  maxSteps?: number
  pause?: () => string | undefined
}): Promise<void> {
  const label = input.session.role === 'router'
    ? 'RouterSession'
    : input.session.role === 'worker' ? 'WorkerSession' : 'WatchdogSession'
  const redact = input.redact
  input.log(`[harness] ${label} turn session=${input.session.id}`)
  const pausedAtStart = input.pause?.()
  if (pausedAtStart) {
    input.log(
      `[collab] turn paused session=${input.session.id} role=${input.session.role} ticketId=${input.session.ticketId ?? '-'} reason=${pausedAtStart}`,
    )
    input.journal.append(input.session.id, { kind: 'paused', content: `paused ${pausedAtStart}` })
    return
  }
  const prompt = redact(input.prompt)
  const prior = messagesFromJournal(input.journal.history(input.session.id)).map(message => ({
    ...message,
    content: redact(message.content),
  }))
  const messages: ModelMessage[] = [
    { role: 'system', content: redact(systemPrompt(input.session.role)) },
    ...prior,
    { role: 'user', content: prompt },
  ]
  input.journal.append(input.session.id, { role: 'user', kind: 'message', content: prompt })
  const tools = input.tools.specsFor(input.session.role)
  const maxSteps = input.maxSteps ?? 10
  for (let step = 0; step < maxSteps; step += 1) {
    const paused = input.pause?.()
    if (paused) {
      input.log(
        `[collab] turn paused session=${input.session.id} role=${input.session.role} ticketId=${input.session.ticketId ?? '-'} step=${step} reason=${paused}`,
      )
      input.journal.append(input.session.id, { kind: 'paused', content: `paused ${paused}` })
      return
    }
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
      const pausedBeforeTool = input.pause?.()
      if (pausedBeforeTool) {
        input.log(
          `[collab] tool held session=${input.session.id} tool=${toolCall.name} ticketId=${input.session.ticketId ?? '-'} reason=${pausedBeforeTool}`,
        )
        input.journal.append(input.session.id, {
          kind: 'paused',
          content: `paused before tool ${toolCall.name}: ${pausedBeforeTool}`,
        })
        return
      }
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
      input.journal.append(input.session.id, {
        role: 'tool',
        name: toolCall.name,
        kind: 'tool',
        toolCallId: toolCall.id,
        content,
      })
    }
  }
}

function messagesFromJournal(entries: JournalEntry[]): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (const entry of entries) {
    if (entry.role !== 'user' && entry.role !== 'assistant' && entry.role !== 'tool') continue
    const message: ModelMessage = {
      role: entry.role,
      content: String(entry.content ?? ''),
    }
    if (entry.name) message.name = entry.name
    if (entry.toolCallId) message.toolCallId = entry.toolCallId
    if (entry.toolCalls?.length) message.toolCalls = entry.toolCalls
    messages.push(message)
  }
  return messages
}
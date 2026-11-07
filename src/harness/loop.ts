import { withSessionRole } from '../core/session-role.ts'
import { redactRecord } from '../env/sanitize.ts'
import type { Metrics } from '../metrics/metrics.ts'
import { formatRefs } from '../memory/graph.ts'
import type { ObjectRef, Role, Ticket, Trigger } from '../shared/types.ts'
import type { Model, ModelMessage } from './model.ts'
import type { SkillInfo } from '../env/skills.ts'
import { systemPrompt, type PromptFiles } from './prompts.ts'
import type { LocalAgentInfo } from '../env/local-agents.ts'
import { directChatThread, routerSessionId, workerSessionId, type JournalEntry, type SessionJournal } from './session.ts'
import { TeamRegistry } from './team.ts'
import { ToolRegistry } from './tools.ts'
import type { Store } from '../store/sqlite.ts'

export interface HarnessOptions {
  model: Model
  /** Optional per-role models (Router is usually lighter than the Worker). */
  models?: Partial<Record<Role, Model>>
  tools: ToolRegistry
  store: Store
  /** Host bookkeeping when a worker session starts. The harness does not hold the Engine. */
  assignmentStarted(ticketId: string, assignmentId: string, sessionId: string): void
  /** Host bookkeeping for logical mesh placement. The Engine owns the ticket write. */
  assignmentPlaced(ticketId: string, assignmentId: string, node: string): void
  journal: SessionJournal
  metrics: Metrics
  redact: (text: string) => string
  log: (line: string) => void
  jobDelayMs: number
  teams?: TeamRegistry
  /** Unseen human guidance for a Router/Worker turn. Marks it injected for that audience. */
  takeGuidance?: (ticketId: string, audience: 'worker' | 'router') => string[]
  /** Router shards for a ticket. Default `['router']`; a shard owns one Router session. */
  routerSessions?: (ticket: Ticket) => string[]
  /** Logical Worker mesh placement. Released by the host on ticket end. */
  pickNode?: (ticketId: string, ticket: Ticket) => string | undefined
  /** When true, the Worker turn runs on a remote peer instead of this process. */
  isRemoteNode?: (nodeId: string | undefined) => boolean
  /** Deliver assignment to a remote mesh node (no local ReAct turn). */
  dispatchRemote?: (ticket: Ticket, node: string) => Promise<void>
  /**
   * Maximum Workers waiting for mesh capacity. `0` rejects instead of queueing.
   * Default 100. The queue lives in the Harness scheduler; the mesh registry
   * stays pure capacity accounting.
   */
  queueLimit?: number
  /** Return a reserved mesh slot when a queued Worker fails before it starts. */
  releaseNode?: (ticketId: string) => void
  /** True when the Router already queued a reply for this ticket. */
  repliedTo?: (ticketId: string) => boolean
  /** End a direct-chat ticket the Router already answered, before a Worker starts. */
  stopAnsweredDirectChat?: (ticket: Ticket, reason: string) => void
  /** Cross-ticket recall lines injected into Router and Worker turns. */
  memory?: (ticket: Ticket) => { id: string; spillId?: string; text: string; refs?: ObjectRef[] }[]
  /** Owner-editable persona, standing instructions, and owner context. */
  prompts?: PromptFiles
  /** Configured local specialists, by id and description only. */
  localAgents?: readonly LocalAgentInfo[]
  /** Owner-authored playbooks, by id and description only. */
  skills?: readonly SkillInfo[]
  /**
   * Router-only global memory. Defaults to `memory`; the Runtime narrows this
   * to same-Thread decisions/digests so a lexical query stays in the Worker
   * callback (a query failure rejects that Worker turn, not `launch`).
   */
  routerMemory?: (ticket: Ticket) => { id: string; spillId?: string; text: string; refs?: ObjectRef[] }[]
  /** T45 bake-off baseline: one turn chain, no Router session. */
  singleSession?: boolean
}

/** Bound for an in-process Worker backlog. Environment parsing already sanitizes. */
export const DEFAULT_QUEUE_LIMIT = 100

/** One redacted entry in a resident Router Session's journal. */
export interface RouterObservation {
  kind: string
  [key: string]: unknown
}

/** Programmatic queue limits are untrusted too: NaN, negative, and fractional fall back. */
export function normalizeQueueLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_QUEUE_LIMIT
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_QUEUE_LIMIT
}

/** Async ReAct loop plus the in-process daemon that launches workers. */
export function routerPromptFor(ticket: Ticket, extraLines: readonly string[] = []): string {
  const mode = ticket.speculative ? 'speculative' : 'normal'
  const directChat = directChatThread(ticket)
  return [
    ticket.speculative ? 'SPECULATIVE' : 'TICKET_CREATED',
    `ticketId=${ticket.id}`,
    `triggerId=${ticket.originTriggerId}`,
    `title=${ticket.title}`,
    // The title is capped at 80 characters; a direct chat needs the whole
    // message because the Router answers it without a Worker reading the brief.
    ...(directChat ? [`message=${ticket.brief}`] : []),
    `mode=${mode}`,
    'decision=accepted-by-gate',
    ...extraLines,
    // A direct iMessage is a conversation, not a thread ticket: the Router may
    // answer it briefly instead of leaving a vetoed message unanswered. Group
    // chats are excluded: only a 1:1 chat gets the conversational exception.
    ...(directChat ? [
      'direct-chat=true',
      'tone=warm, playful, cute: when they are comfortable, put 1-2 emoji in your reply, react to what they said, and end with an easy question. Write one short paragraph by default; add a second or third bubble only for a genuinely separate thought (no headings or lists). When answering an earlier line rather than the newest message, start that bubble with a short "> quote" of the earlier line. Follow their latest style instruction (stop using a word, emoji, or tone when asked) over this default. If they went quiet, open a fresh topic or tease them gently; never close the chat.',
    ] : []),
    'If this ticket should not run, call assess_trigger with kind=stop before the worker starts.',
  ].join('\n')
}

export class Harness {
  private readonly chains = new Map<string, Promise<void>>()
  private inflight: Promise<void>[] = []
  private readonly running = new Set<string>()
  private readonly pendingJobs: Promise<void>[] = []
  private readonly routersReady = new Set<string>()
  /** FIFO of Workers waiting for mesh capacity. Owned by the scheduler, not the registry. */
  private readonly queued: { ticketId: string; resolve: () => void }[] = []
  /** Tickets whose Worker turn promise has not settled yet. */
  private readonly activeWorkers = new Set<string>()
  private readonly queueLimit: number
  private draining = false

  constructor(private readonly opts: HarnessOptions) {
    this.queueLimit = normalizeQueueLimit(opts.queueLimit)
    const byRole = Object.entries(opts.models ?? {})
      .filter(([, model]) => model != null)
      .map(([role, model]) => `${role}=${model.name}`)
    if (byRole.length) this.opts.log(`[harness] role models ${byRole.join(' ')}`)
  }

  private modelFor(role: Role): Model {
    return this.opts.models?.[role] ?? this.opts.model
  }

  /**
   * A Router is a resident Session, not a per-Ticket worker. `Runtime.start()`
   * arms every configured shard so the Session row and its journal exist
   * before the first Trigger; a later process keeps the original `createdAt`
   * and appends a resume event instead of a second start.
   */
  armRouter(shard = 'router'): void {
    if (this.opts.singleSession) return
    const sessionId = routerSessionId(shard)
    if (this.routersReady.has(sessionId)) return
    this.routersReady.add(sessionId)
    const now = new Date().toISOString()
    const existing = this.opts.store.isOpen
      ? this.opts.store.listSessions().find(row => row.id === sessionId)
      : undefined
    if (this.opts.store.isOpen) {
      this.opts.store.upsertSession({
        id: sessionId,
        role: 'router',
        status: 'idle',
        heartbeat: now,
        createdAt: existing?.createdAt ?? now,
      })
    }
    this.opts.journal.append(sessionId, existing
      ? {
        kind: 'session.resumed',
        content: `resumed role=router resident=true since=${existing.createdAt}`,
      }
      : { kind: 'session.started', content: 'started role=router resident=true' })
    this.opts.log(
      `[harness] MainSession start session=${sessionId} role=router resident=true`
      + (existing ? ' resumed=true' : ''),
    )
  }

  /**
   * Append one redacted event to a resident Router journal. Only an armed
   * Router observes; events before `Runtime.start()` are not part of its life.
   * The entry has no model role, so it is durable session memory rather than a
   * fake user turn in the replay.
   */
  routerObserve(shard: string, event: RouterObservation): void {
    if (this.opts.singleSession) return
    const sessionId = routerSessionId(shard)
    if (!this.routersReady.has(sessionId)) return
    this.opts.journal.append(sessionId, {
      kind: `observe.${event.kind}`,
      content: this.opts.redact(describeObservation(event)),
    })
  }

  /** Recent observed events and assessment outcomes from one Router Session. */
  routerHistory(shard = 'router', limit = 12): string[] {
    if (limit <= 0) return []
    const sessionId = routerSessionId(shard)
    return this.opts.journal.history(sessionId)
      .filter(entry => typeof entry.content === 'string' && entry.kind?.startsWith('observe.'))
      .slice(-limit)
      .map(entry => entry.content as string)
  }

  /**
   * Run one Router-owned unit of work on that shard's Session chain. Assessment
   * and ticket turns then share one sequence, so a resident Session never has
   * two overlapping turns.
   */
  routerExclusive<T>(shard: string, work: () => Promise<T>): Promise<T> {
    if (this.opts.singleSession) return work()
    this.armRouter(shard)
    return this.enqueue(routerSessionId(shard), work)
  }

  private withRouterHistory(shard: string, prompt: string): string {
    const history = this.routerHistory(shard, 6)
    if (!history.length) return prompt
    return `${prompt}\n${history.map(line => `observed=${line}`).join('\n')}`
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
    const shards = this.opts.singleSession
      ? []
      : this.opts.routerSessions?.(ticket) ?? ['default']
    for (const shard of shards) this.armRouter(shard)
    this.opts.log(`[harness] dual-layer routers=${shards.map(routerSessionId).join(',') || '-'} ExecutorSession=${sessionId} ticketId=${ticket.id}`)
    if (this.running.size >= 2) {
      this.opts.log(`[harness] parallel workers=${this.running.size} sessions=${[...this.running].join(',')}`)
    }
    if (!ticket.assignments.at(-1)) throw new Error(`ticket ${ticket.id} has no assignment`)
    const refsLine = formatRefs(ticket.refs)
    const routerPrompt = routerPromptFor(ticket, [
      ...(refsLine ? [refsLine] : []),
      ...this.memoryLines(ticket, 'router'),
    ])
    // Sequence point (T06/T08): Router turn(s) complete first. A Router veto
    // (assess_trigger stop/ignore) ends the ticket, and the Worker never starts.
    // Capacity is picked after the Routers so a veto never consumes a slot.
    const startWorker = (): Promise<void> | undefined => {
      // A direct chat the Router already answered is finished. Give the
      // conversation no Worker even when the Router forgot assess_trigger
      // stop: a conversational reply is the whole deliverable.
      const directChat = directChatThread(ticket) !== undefined
      if (directChat && this.opts.repliedTo?.(ticket.id)) {
        const latest = this.opts.store.getDoc<Ticket>('ticket', ticket.id)
        this.opts.log(`[harness] worker skipped ticketId=${ticket.id} ended=answered-direct-chat`)
        if (!latest?.ended) {
          this.opts.stopAnsweredDirectChat?.(ticket, 'direct-chat answered by Router')
        }
        return undefined
      }
      return this.startOrQueue(ticket.id)
    }
    let chain: Promise<void> = Promise.resolve()
    if (this.opts.singleSession) {
      this.opts.log(`[harness] single-session ticketId=${ticket.id}`)
    } else {
      for (const shard of shards) {
        const session = routerSessionId(shard)
        chain = chain.then(() => this.enqueue(session, () => this.run(
          session,
          'router',
          undefined,
          `${this.withRouterHistory(shard, routerPrompt)}\nshard=${shard}`,
        )))
      }
    }
    const work = chain
      .then(startWorker)
      .then(() => undefined)
      .finally(() => {
        this.running.delete(ticket.id)
      })
    return this.track(work)
  }

  /** Start the Worker now, or park it in the bounded FIFO until a slot frees. */
  private startOrQueue(ticketId: string): Promise<void> | undefined {
    const latest = this.opts.store.isOpen
      ? this.opts.store.getDoc<Ticket>('ticket', ticketId)
      : undefined
    if (!latest) {
      this.opts.log(`[harness] worker skipped ticketId=${ticketId} ticket-missing`)
      return
    }
    if (latest.ended) {
      this.opts.log(`[harness] worker skipped ticketId=${ticketId} ended=${latest.ended.outcome}`)
      return
    }
    const paused = this.pauseReason(ticketId)
    if (paused) {
      this.opts.log(`[harness] worker skipped ticketId=${ticketId} paused reason=${paused}`)
      return
    }
    if (!latest.assignments.at(-1)) {
      this.opts.log(`[harness] worker skipped ticketId=${ticketId} no-assignment`)
      return
    }
    // No mesh configured: keep the original no-placement behavior.
    if (!this.opts.pickNode) return this.startNow(latest)
    const node = this.opts.pickNode(latest.id, latest)
    if (!node) return this.enqueueWorker(latest.id)
    this.opts.log(`[mesh] place ticketId=${latest.id} node=${node}`)
    return this.startNow(latest, node)
  }

  /**
   * Start a non-queued Worker turn. `startWorkerTurn` marks the ticket active
   * before the host callbacks run; a synchronous throw there must not leak the
   * active marker or the mesh slot `pickNode` already reserved, and the launch
   * must resolve instead of rejecting. The same holds when the turn rejects
   * asynchronously: `.finally` in `startWorkerTurn` already cleared the active
   * marker and pumped, so only the reserved mesh slot is left to return.
   *
   * Both failure paths release the node and then pump: `startWorkerTurn`'s own
   * pump runs while the failed turn still owns the slot, so a queued Worker
   * would stay parked on a node that is free by the time this handler returns.
   * Pumping is safe here, not a double start: the synchronous path threw before
   * a turn was enqueued, and the asynchronous path only runs after the failed
   * turn has settled, so no Worker overlap is possible.
   */
  private startNow(ticket: Ticket, node?: string): Promise<void> {
    let work: Promise<void>
    try {
      work = this.startWorkerTurn(ticket, node)
    } catch (error) {
      this.activeWorkers.delete(ticket.id)
      if (node) this.opts.releaseNode?.(ticket.id)
      this.opts.log(`[harness] worker failed ticketId=${ticket.id} error=${String(error)}`)
      if (node) this.pump()
      return Promise.resolve()
    }
    return work.catch(error => {
      if (node) this.opts.releaseNode?.(ticket.id)
      this.opts.log(`[harness] worker failed ticketId=${ticket.id} error=${String(error)}`)
      if (node) this.pump()
    })
  }

  private enqueueWorker(ticketId: string): Promise<void> {
    if (this.queued.length >= this.queueLimit) {
      this.opts.metrics.increment('mesh.queue_rejected')
      this.opts.log(
        `[mesh] mesh.queue-full ticketId=${ticketId} depth=${this.queued.length} limit=${this.queueLimit}`,
      )
      return Promise.resolve()
    }
    let resolve!: () => void
    const done = new Promise<void>(accept => {
      resolve = accept
    })
    this.queued.push({ ticketId, resolve })
    this.opts.metrics.increment('mesh.queued')
    this.opts.log(`[mesh] mesh.queued ticketId=${ticketId} depth=${this.queued.length} limit=${this.queueLimit}`)
    return done
  }

  /**
   * Dequeue while capacity allows. The head is re-read from the Store: a ticket
   * that ended or paused while waiting is skipped and its launch resolves. A
   * full mesh stops the pump at the head, preserving FIFO order.
   */
  private pump(): void {
    if (this.draining) return
    while (this.queued.length > 0) {
      const next = this.queued[0]!
      const check = this.queueState(next.ticketId)
      if (check.skip || !check.ticket) {
        this.queued.shift()
        this.opts.metrics.increment('mesh.dequeued')
        this.opts.log(`[mesh] mesh.dequeued ticketId=${next.ticketId} depth=${this.queued.length} skipped=${check.skip ?? 'ticket-missing'}`)
        next.resolve()
        continue
      }
      if (this.opts.pickNode) {
        const node = this.opts.pickNode(next.ticketId, check.ticket)
        if (!node) return
        this.queued.shift()
        this.opts.metrics.increment('mesh.dequeued')
        this.opts.log(`[mesh] mesh.dequeued ticketId=${next.ticketId} depth=${this.queued.length}`)
        this.startQueued(next, node)
        continue
      }
      // Queued entries only exist when pickNode is configured.
      this.queued.shift()
      next.resolve()
    }
  }

  /**
   * Read the committed snapshot for a queued launch. A terminal Assignment
   * (`ended`) is as fatal as an ended or paused Ticket: a report may have ended
   * it without ending the Ticket, and starting it would resurrect the turn.
   */
  private queueState(ticketId: string): { ticket?: Ticket; skip?: string } {
    if (!this.opts.store.isOpen) return { skip: 'store-closed' }
    const ticket = this.opts.store.getDoc<Ticket>('ticket', ticketId)
    if (!ticket) return { skip: 'ticket-missing' }
    if (ticket.ended) return { skip: `ended=${ticket.ended.outcome}` }
    const paused = this.pauseReason(ticketId)
    if (paused) return { skip: 'paused' }
    const assignment = ticket.assignments.at(-1)
    if (!assignment) return { skip: 'no-assignment' }
    if (assignment.state === 'ended') return { skip: 'assignment-ended' }
    if (assignment.report?.kind === 'failed' || assignment.report?.kind === 'blocked') {
      return { skip: `assignment-${assignment.report.kind}` }
    }
    return { ticket }
  }

  private startQueued(
    entry: { ticketId: string; resolve: () => void },
    node: string,
  ): void {
    // Final re-read immediately before the turn starts. This is the barrier
    // that keeps a just-ended Ticket from being resurrected by a stale pump.
    const check = this.queueState(entry.ticketId)
    if (!check.ticket) {
      // pump() already reserved a mesh slot for this entry; give it back.
      this.opts.releaseNode?.(entry.ticketId)
      this.opts.log(`[mesh] mesh.start-skipped ticketId=${entry.ticketId} reason=${check.skip}`)
      entry.resolve()
      return
    }
    let work: Promise<void>
    try {
      work = this.startWorkerTurn(check.ticket, node)
    } catch (error) {
      // startWorkerTurn marks the ticket active before Engine callbacks run.
      // If one throws, neither the active marker nor the mesh reservation may leak.
      this.activeWorkers.delete(entry.ticketId)
      this.opts.releaseNode?.(entry.ticketId)
      this.opts.log(`[harness] queued worker failed ticketId=${entry.ticketId} error=${String(error)}`)
      entry.resolve()
      return
    }
    // The queued launch resolves when this Worker turn settles, or on drain.
    work.then(() => entry.resolve(), () => entry.resolve())
    this.track(work)
  }

  /**
   * The host calls this from `onTicketEnded`, after the mesh slot is released.
   * A Worker turn that ends its own ticket is still unwinding, so defer the
   * pump to that turn's `finally` and never overlap two Worker turns.
   */
  release(ticketId: string): void {
    if (this.activeWorkers.has(ticketId)) return
    this.pump()
  }

  private startWorkerTurn(ticket: Ticket, node?: string): Promise<void> {
    const sessionId = workerSessionId(ticket.id)
    const assignment = ticket.assignments.at(-1)
    if (!assignment) {
      this.opts.log(`[harness] worker skipped ticketId=${ticket.id} no-assignment`)
      return Promise.resolve()
    }
    if (node && this.opts.isRemoteNode?.(node)) {
      this.activeWorkers.add(ticket.id)
      this.opts.log(`[mesh] remote dispatch ticketId=${ticket.id} node=${node}`)
      this.opts.assignmentStarted(ticket.id, assignment.id, sessionId)
      this.opts.assignmentPlaced(ticket.id, assignment.id, node)
      const work = (this.opts.dispatchRemote?.(ticket, node) ?? Promise.resolve())
      return work.finally(() => {
        this.activeWorkers.delete(ticket.id)
        this.pump()
      })
    }
    this.activeWorkers.add(ticket.id)
    this.opts.log(`[harness] ExecutorSession start session=${sessionId} ticketId=${ticket.id} role=worker`)
    this.opts.assignmentStarted(ticket.id, assignment.id, sessionId)
    if (node) this.opts.assignmentPlaced(ticket.id, assignment.id, node)
    return this.enqueue(
      sessionId,
      () => this.run(sessionId, 'worker', ticket.id, this.workerTask(ticket, node)),
    ).finally(() => {
      this.activeWorkers.delete(ticket.id)
      this.pump()
    })
  }

  private workerTask(ticket: Ticket, node?: string): string {
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
    if (node) task.push(`node=${node}`)
    const refs = formatRefs(ticket.refs)
    if (refs) task.push(refs)
    // Restart recovery (P1-6): the relaunch turn must tell the Worker that a
    // previous process died. Only RECOVERED context inputs are injected here;
    // ordinary context inputs stay read-only background for resume/report paths.
    for (const input of ticket.inputs) {
      if (input.kind === 'context' && input.text?.startsWith('RECOVERED:')) {
        task.push(`recovered=${input.text}`)
      }
    }
    for (const line of this.memoryLines(ticket, 'worker')) task.push(line)
    return task.join('\n')
  }

  /**
   * Chain-of-recall lines. Every entry keeps its spill id and next-hop refs in
   * the window; the model follows them with `read_object` only when needed.
   */
  private memoryLines(ticket: Ticket, role: 'router' | 'worker'): string[] {
    const source = role === 'router' ? this.opts.routerMemory ?? this.opts.memory : this.opts.memory
    return (source?.(ticket) ?? []).map(entry => {
      const spill = entry.spillId ? ` spillId=${entry.spillId}` : ''
      const refs = formatRefs(entry.refs)
      return `memory=${entry.id}${spill}${refs ? ` ${refs}` : ''} text=${entry.text}`
    })
  }

  deliver(ticketId: string, trigger: Trigger, spillId?: string): Promise<void> {
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
    // Engine-owned spill only: the ingress sidecar, or the spill already on the ticket.
    const owned = spillId ?? ticket?.spillId ?? ''
    if (owned) lines.push(`spillId=${owned}`)
    const refs = formatRefs(trigger.refs)
    if (refs) lines.push(refs)
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
    const shards = this.opts.singleSession
      ? []
      : this.opts.routerSessions?.(ticket) ?? ['default']
    for (const shard of shards) this.armRouter(shard)
    this.opts.log(
      `[harness] ExecutorSession resume session=${sessionId} ticketId=${ticket.id} role=worker guidanceSince=${since ?? '-'}`,
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
      const refsLine = formatRefs(ticket.refs)
      if (refsLine) lines.push(refsLine)
      for (const memory of this.memoryLines(ticket, 'router')) lines.push(memory)
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

    let chain: Promise<void> = Promise.resolve()
    if (this.opts.singleSession) {
      this.opts.log(`[harness] single-session resume ticketId=${ticket.id}`)
    } else {
      for (const shard of shards) {
        const session = routerSessionId(shard)
        chain = chain.then(() => this.enqueue(
          session,
          () => guarded(session, 'router', guidance =>
            `${this.withRouterHistory(shard, routerPrompt(guidance))}\nshard=${shard}`),
        ))
      }
    }
    const work = chain
      .then(() => {
        const latest = this.opts.store.isOpen
          ? this.opts.store.getDoc<Ticket>('ticket', ticket.id)
          : undefined
        if (!latest || latest.ended) return
        return this.enqueue(sessionId, () => guarded(sessionId, 'worker', workerPrompt))
      })
      .then(() => undefined)
      .finally(() => {
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
          // stop_job marks the row stopped. The timer must not resurrect it.
          const row = this.opts.store.getJob(job.id)
          if (!row || row.status !== 'running') {
            this.opts.log(`[job] async job skipped jobId=${job.id} status=${row?.status ?? 'missing'}`)
            resolve()
            return
          }
          // A ticket can end (deliver, discard, Router stop, watchdog fail) while a job runs.
          // Its completion must not start a fresh Worker turn on a finished ticket.
          const ticket = this.opts.store.getDoc<Ticket>('ticket', job.ticketId)
          if (!ticket || ticket.ended) {
            this.opts.store.completeJob(job.id, 'stopped')
            this.opts.log(`[job] async job skipped jobId=${job.id} ticket=${ticket ? 'ended' : 'missing'}`)
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
    if (this.opts.singleSession) {
      this.opts.log('[harness] single-session router turn skipped')
      return Promise.resolve()
    }
    // A report belongs to the ticket's shard, not always the default Router.
    const ticketId = /^ticketId=(\S+)$/m.exec(prompt)?.[1]
    const ticket = ticketId && this.opts.store.isOpen
      ? this.opts.store.getDoc<Ticket>('ticket', ticketId)
      : undefined
    const shard = ticket
      ? (this.opts.routerSessions?.(ticket) ?? ['default'])[0] ?? 'default'
      : 'default'
    const session = routerSessionId(shard)
    this.armRouter(shard)
    // Report turns decide delivery, so they need the same resident timeline as
    // launch and assessment turns. Without it the busiest Router path sees no
    // observed Trigger, decision, or ticket lifecycle.
    return this.enqueue(session, () => this.run(
      session,
      'router',
      undefined,
      this.withRouterHistory(shard, prompt),
    ))
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
    this.draining = true
    try {
      for (let wave = 0; wave < 40; wave += 1) {
        // Queued launches never start during a drain; resolve them so shutdown
        // is bounded. The tickets stay open in the Store for a later retry.
        this.drainQueue()
        if (this.inflight.length === 0) return
        const batch = this.inflight.splice(0, this.inflight.length)
        const results = await Promise.allSettled(batch)
        const failed = results.find(result => result.status === 'rejected')
        if (failed && failed.status === 'rejected') throw failed.reason
        if (this.queued.length === 0 && this.inflight.length === 0) return
      }
      this.drainQueue()
      if (this.inflight.length > 0) throw new Error('harness drain did not settle')
    } finally {
      this.draining = false
    }
  }

  private drainQueue(): void {
    if (this.queued.length === 0) return
    const pending = this.queued.splice(0, this.queued.length)
    for (const entry of pending) entry.resolve()
    this.opts.metrics.increment('mesh.queue_drained', pending.length)
    this.opts.log(`[mesh] mesh.queue_drained count=${pending.length}`)
  }

  async jobsSettled(): Promise<void> {
    for (let wave = 0; wave < 20; wave += 1) {
      // Settle, do not drain: queued Workers must get their turn as capacity
      // frees. Only the explicit shutdown path clears the queue.
      await this.settleInflight()
      if (this.pendingJobs.length === 0) return
      const batch = this.pendingJobs.splice(0, this.pendingJobs.length)
      await Promise.all(batch)
    }
    throw new Error('jobs did not settle')
  }

  /** Wait for every tracked turn/launch without dropping queued Workers. */
  private async settleInflight(): Promise<void> {
    for (let wave = 0; wave < 40; wave += 1) {
      if (this.inflight.length === 0) return
      const batch = this.inflight.splice(0, this.inflight.length)
      const results = await Promise.allSettled(batch)
      const failed = results.find(result => result.status === 'rejected')
      if (failed && failed.status === 'rejected') throw failed.reason
    }
    if (this.inflight.length > 0) throw new Error('harness settle did not settle')
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
    // Only a Worker call passes the ticket id explicitly. Router turns reach
    // this method through the prompt regex; an approval wait must stop the
    // Worker but not the Router's question to the owner.
    const explicit = ticketId !== undefined
    const id = ticketId ?? /^ticketId=(\S+)$/m.exec(prompt ?? '')?.[1]
    if (!id) return undefined
    const ticket = this.opts.store.getDoc<Ticket>('ticket', id)
    if (explicit) {
      const approval = ticket?.collab?.approvals?.find(item => item.status === 'pending')
      if (approval) return `approval=${approval.id} at=${approval.at}`
    }
    const paused = ticket?.collab?.paused
    if (!paused) return undefined
    const reason = paused.reason ? ` reason=${paused.reason}` : ''
    return `at=${paused.at} by=${paused.by}${reason}`
  }

  private enqueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.chains.set(sessionId, next.then(() => undefined, () => undefined))
    return next
  }

  private async run(sessionId: string, role: Role, ticketId: string | undefined, prompt: string): Promise<void> {
    if (!this.opts.store.isOpen) return
    // A resident Router owns one stable creation time; a ticket turn must not
    // reset it like a per-Ticket Worker session.
    const existing = this.opts.store.listSessions().find(row => row.id === sessionId)
    const createdAt = existing?.createdAt ?? new Date().toISOString()
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
        model: this.modelFor(role),
        tools: this.opts.tools,
        journal: this.opts.journal,
        log: this.opts.log,
        metrics: this.opts.metrics,
        redact: this.opts.redact,
        session: { id: sessionId, role, ticketId },
        prompt,
        prompts: this.opts.prompts,
        localAgents: this.opts.localAgents,
        skills: this.opts.skills,
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
  prompts?: PromptFiles
  localAgents?: readonly LocalAgentInfo[]
  skills?: readonly SkillInfo[]
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
  prompts?: PromptFiles
  localAgents?: readonly LocalAgentInfo[]
  skills?: readonly SkillInfo[]
  maxSteps?: number
  pause?: () => string | undefined
}): Promise<void> {
  const label = input.session.role === 'router'
    ? 'MainSession'
    : input.session.role === 'worker' ? 'ExecutorSession' : 'WatchdogSession'
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
    { role: 'system', content: redact(systemPrompt(input.session.role, input.prompts, input.localAgents, input.skills)) },
    ...prior,
    { role: 'user', content: prompt },
  ]
  input.journal.append(input.session.id, { role: 'user', kind: 'message', content: prompt })
  const tools = await input.tools.specsFor(input.session.role)
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
    // A model/transport failure ends this turn cleanly. The assignment stays
    // running, which is exactly the signal the Watchdog detects (T43).
    let out: Awaited<ReturnType<Model['complete']>>
    try {
      input.metrics.increment('model.call')
      out = await input.model.complete({ role: input.session.role, messages, tools })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      input.log(`[harness] model error session=${input.session.id} role=${input.session.role} error=${message}`)
      input.metrics.increment('model.error')
      input.journal.append(input.session.id, { kind: 'error', content: `model error: ${message}` })
      return
    }
    input.metrics.observeModelLatency(performance.now() - started)
    const text = redact(out.text ?? '')
    const calls = (out.toolCalls ?? []).map(toolCall => ({
      ...toolCall,
      args: redactRecord(toolCall.args, redact),
    }))
    messages.push({ role: 'assistant', content: text, toolCalls: calls })
    input.journal.append(input.session.id, { role: 'assistant', kind: 'message', content: text, toolCalls: calls })
    if (calls.length === 0) break
    for (let index = 0; index < calls.length; index += 1) {
      const toolCall = calls[index]!
      const pausedBeforeTool = input.pause?.()
      if (pausedBeforeTool) {
        input.log(
          `[collab] tool held session=${input.session.id} tool=${toolCall.name} ticketId=${input.session.ticketId ?? '-'} reason=${pausedBeforeTool}`,
        )
        // The assistant message above already carries the whole toolCalls
        // batch. A provider rejects a replay with tool_calls that have no tool
        // result, so close every call we are not executing before returning.
        // RESUME then replays a complete transcript instead of an invalid one.
        const approval = pausedBeforeTool.startsWith('approval=')
        const content = redact(JSON.stringify(approval
          ? { held: 'approval', reason: pausedBeforeTool }
          : { held: 'paused' }))
        for (const remaining of calls.slice(index)) {
          messages.push({ role: 'tool', name: remaining.name, toolCallId: remaining.id, content })
          input.journal.append(input.session.id, {
            role: 'tool',
            name: remaining.name,
            kind: 'tool',
            toolCallId: remaining.id,
            content,
          })
        }
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

/** Bound the replayed transcript. The full journal stays on disk. */
const MAX_HISTORY_ENTRIES = 200

/** A resident Router keeps a compact timeline; long bodies stay in the spill. */
const MAX_OBSERVATION_CHARS = 400
const MAX_OBSERVATION_FIELD_CHARS = 160

function describeObservation(event: RouterObservation): string {
  const parts = [`event=${event.kind}`]
  for (const [key, value] of Object.entries(event)) {
    if (key === 'kind' || value === undefined || value === null || value === '') continue
    const text = Array.isArray(value) ? value.join(',') : String(value)
    parts.push(`${key}=${text.replace(/\s+/g, ' ').trim().slice(0, MAX_OBSERVATION_FIELD_CHARS)}`)
  }
  return parts.join(' ').slice(0, MAX_OBSERVATION_CHARS)
}

function messagesFromJournal(entries: JournalEntry[]): ModelMessage[] {
  const messages: ModelMessage[] = []
  // Observations are durable session memory with no model role. Filter them
  // first: applying the cap to the raw journal would let a busy Router's
  // observe.* entries push every real turn out of the replayed transcript.
  const replayable = entries.filter(entry =>
    entry.role === 'user' || entry.role === 'assistant' || entry.role === 'tool')
  let recent = replayable.length > MAX_HISTORY_ENTRIES
    ? replayable.slice(-MAX_HISTORY_ENTRIES)
    : replayable
  if (replayable.length > MAX_HISTORY_ENTRIES) {
    // Never start mid tool-call: begin at the first user message in the slice.
    const firstUser = recent.findIndex(entry => entry.role === 'user')
    if (firstUser > 0) recent = recent.slice(firstUser)
  }
  for (const entry of recent) {
    const message: ModelMessage = {
      role: entry.role as 'user' | 'assistant' | 'tool',
      content: String(entry.content ?? ''),
    }
    if (entry.name) message.name = entry.name
    if (entry.toolCallId) message.toolCallId = entry.toolCallId
    if (entry.toolCalls?.length) message.toolCalls = entry.toolCalls
    messages.push(message)
  }
  return messages
}
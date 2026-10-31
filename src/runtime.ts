import path from 'node:path'
import { Engine } from './core/engine.ts'
import type { Host } from './core/host.ts'
import { Daemon } from './harness/daemon.ts'
import { Harness } from './harness/loop.ts'
import { createModelFromEnv, type Model } from './harness/model.ts'
import { SessionJournal } from './harness/session.ts'
import { ToolRegistry } from './harness/tools.ts'
import { filterTrigger } from './ingress/filter.ts'
import { MemoryApi } from './memory/long-term.ts'
import { inlineOrSpill } from './memory/recall.ts'
import { selectShard, singleProcessShards, type RouterShardConfig } from './router/shard.ts'
import { Logger } from './shared/log.ts'
import type { Disposition, ReceiveResult, SessionLayering, Ticket, Trigger } from './shared/types.ts'
import { LocalEnv } from './env/local-env.ts'
import { Store } from './store/sqlite.ts'
import { Watchdog } from './watchdog/watchdog.ts'

export interface RuntimeOptions {
  home: string
  model?: Model
  jobDelayMs?: number
  watchdogIntervalMs?: number
  stuckMs?: number
  now?: () => string
  layering?: SessionLayering
  shards?: RouterShardConfig
}

export class Runtime {
  readonly log: Logger
  readonly store: Store
  readonly engine: Engine
  readonly harness: Harness
  readonly watchdog: Watchdog
  readonly daemon: Daemon
  readonly model: Model
  readonly memory: MemoryApi
  readonly home: string
  readonly layering: SessionLayering
  readonly shards: RouterShardConfig

  private constructor(parts: {
    home: string
    log: Logger
    store: Store
    engine: Engine
    harness: Harness
    watchdog: Watchdog
    daemon: Daemon
    model: Model
    memory: MemoryApi
    layering: SessionLayering
    shards: RouterShardConfig
  }) {
    this.home = parts.home
    this.log = parts.log
    this.store = parts.store
    this.engine = parts.engine
    this.harness = parts.harness
    this.watchdog = parts.watchdog
    this.daemon = parts.daemon
    this.model = parts.model
    this.memory = parts.memory
    this.layering = parts.layering
    this.shards = parts.shards
  }

  static create(opts: RuntimeOptions): Runtime {
    const log = new Logger()
    const model = opts.model ?? createModelFromEnv()
    const store = new Store(opts.home)
    const layering = opts.layering ?? 'dual'
    const shards = opts.shards ?? singleProcessShards()
    const memory = new MemoryApi(store)
    const now = opts.now ?? (() => new Date().toISOString())
    log.info(`[runtime] model=${model.name}`)
    const host: Host = {
      repo: store,
      now,
      log: line => log.info(line),
      scope: {
        admit: trigger => {
          if (trigger.meta.admitted === true) return { listened: true, reason: 'admitted' }
          const verdict = filterTrigger(trigger, model)
          if (verdict.action === 'drop') return { listened: false, reason: `${verdict.layer}:${verdict.reason}` }
          return { listened: true, reason: verdict.reason }
        },
      },
      onQueued: (threadKey, triggerId, pending) => {
        log.info(`[ingress] batch-hook thread=${threadKey} triggerId=${triggerId} pending=${pending.length}`)
      },
    }
    const engine = new Engine(host)
    const env = new LocalEnv(path.join(opts.home, 'workspaces'))
    const journal = new SessionJournal(path.join(opts.home, 'sessions'), store, line => log.info(line))
    const late: { harness?: Harness } = {}
    const tools = new ToolRegistry({
      store,
      engine,
      env,
      log: line => log.info(line),
      scheduleJob: job => {
        if (!late.harness) throw new Error('harness is not ready')
        late.harness.scheduleJob(job)
      },
      routerTurn: prompt => {
        if (!late.harness) throw new Error('harness is not ready')
        return late.harness.routerTurn(prompt)
      },
      layering,
    })
    const harness = new Harness({
      model,
      tools,
      store,
      engine,
      journal,
      log: line => log.info(line),
      jobDelayMs: opts.jobDelayMs ?? 40,
      layering,
    })
    late.harness = harness
    const watchdog = new Watchdog({
      store,
      log: line => log.info(line),
      intervalMs: opts.watchdogIntervalMs ?? 15_000,
      stuckMs: opts.stuckMs ?? 60_000,
    })
    const daemon = new Daemon(watchdog, line => log.info(line))
    return new Runtime({
      home: opts.home,
      log,
      store,
      engine,
      harness,
      watchdog,
      daemon,
      model,
      memory,
      layering,
      shards,
    })
  }

  start(): void {
    this.daemon.start()
  }

  /** Ingress, then Engine.receive, then Eval for anything that was not a subscription bypass. */
  ingest(trigger: Trigger): ReceiveResult {
    const shard = selectShard(this.shards, trigger)
    this.log.info(`[router] shard=${shard.id} mode=${this.shards.mode} harness=${shard.harness}`)
    if (this.store.getDoc<Trigger>('trigger', trigger.id)) {
      const result = this.engine.receive(trigger)
      this.log.info(`[engine] Intake.receive id=${trigger.id} result=${result}`)
      return result
    }
    const verdict = filterTrigger(trigger, this.model)
    this.log.info(
      `[ingress] two-level fast=${verdict.fast} semantic=${verdict.semantic} model=${this.model.name} action=${verdict.action} layer=${verdict.layer}`,
    )
    let incoming = trigger
    if (verdict.action === 'pass') {
      const recall = inlineOrSpill(trigger.text, body => this.store.putSpill(body))
      if (recall.spillId) {
        this.log.info(`[memory] Inline/Spill chain-of-recall spillId=${recall.spillId} bytes=${recall.bytes}`)
        this.memory.remember({
          spillId: recall.spillId,
          summary: recall.inline,
          preview: trigger.text,
        })
      }
      const meta: Record<string, unknown> = {
        ...trigger.meta,
        admitted: true,
        strength: verdict.strength ?? 'inferred',
        label: trigger.text.replace(/\s+/g, ' ').trim().slice(0, 80),
      }
      if (recall.spillId) meta.spillId = recall.spillId
      incoming = { ...trigger, text: recall.inline, meta }
    }
    const result = this.engine.receive(incoming)
    this.log.info(`[engine] Intake.receive id=${incoming.id} result=${result}`)
    if (result === 'filtered') {
      this.log.info('noise dropped')
      return result
    }
    if (result !== 'stored') return result
    for (const decision of this.engine.evaluateDue()) {
      if (decision.kind === 'accept' && decision.ticketId) {
        const ticket = this.store.getDoc<Ticket>('ticket', decision.ticketId)
        if (!ticket) continue
        if (ticket.spillId) this.memory.attach(ticket.spillId, ticket.id)
        this.harness.launch(ticket)
      }
    }
    const disposition = this.store.getDoc<Disposition>('disposition', incoming.id)
    const spilled = typeof incoming.meta.spillId === 'string' ? incoming.meta.spillId : undefined
    for (const ticketId of disposition?.fanout ?? []) {
      if (spilled) this.memory.attach(spilled, ticketId)
      this.harness.deliver(ticketId, incoming)
    }
    return result
  }

  watchdogTurn(): Promise<void> {
    return this.harness.watchdogTurn()
  }

  drain(): Promise<void> {
    return this.harness.drain()
  }

  jobsSettled(): Promise<void> {
    return this.harness.jobsSettled()
  }

  /** Wait for jobs, stop the daemon, and close SQLite. */
  async finish(): Promise<void> {
    await this.harness.jobsSettled()
    this.daemon.stop()
    if (this.store.isOpen) this.store.close()
  }
}

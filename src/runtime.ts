import path from 'node:path'
import { Engine } from './core/engine.ts'
import { bindRolePorts } from './core/role-ports.ts'
import type { Host } from './core/host.ts'
import { LocalEnv } from './env/local-env.ts'
import { redactSecrets, secretValues } from './env/sanitize.ts'
import { Daemon } from './harness/daemon.ts'
import { Harness } from './harness/loop.ts'
import { createModelFromEnv, type Model } from './harness/model.ts'
import { SessionJournal } from './harness/session.ts'
import { ToolRegistry } from './harness/tools.ts'
import { filterTrigger } from './ingress/filter.ts'
import { inlineOrSpill } from './memory/recall.ts'
import { Metrics } from './metrics/metrics.ts'
import { Logger } from './shared/log.ts'
import type { Disposition, ReceiveResult, Ticket, Trigger } from './shared/types.ts'
import { Store } from './store/sqlite.ts'
import { Watchdog } from './watchdog/watchdog.ts'

export interface RuntimeOptions {
  home: string
  model?: Model
  jobDelayMs?: number
  watchdogIntervalMs?: number
  stuckMs?: number
  now?: () => string
  /** Environment for the LocalEnv allowlist and secret redaction. Model selection still reads process.env. */
  env?: NodeJS.ProcessEnv
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
  }

  static create(opts: RuntimeOptions): Runtime {
    const baseEnv = opts.env ?? process.env
    const secrets = secretValues(baseEnv)
    const redact = (text: string) => redactSecrets(text, secrets)
    const log = new RedactingLogger(redact)
    const model = opts.model ?? createModelFromEnv()
    const store = new Store(opts.home)
    const metrics = new Metrics(opts.home)
    const now = opts.now ?? (() => new Date().toISOString())
    log.info(`[runtime] model=${model.name}`)
    const host: Host = {
      repo: store,
      now,
      metrics,
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
    const env = new LocalEnv(path.join(opts.home, 'workspaces'), { env: baseEnv })
    const journal = new SessionJournal(path.join(opts.home, 'sessions'), store, line => log.info(line))
    const late: { harness?: Harness } = {}
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
    })
    const harness = new Harness({
      model,
      tools,
      store,
      assignmentStarted: (ticketId, assignmentId, sessionId) => {
        engine.assignmentStarted(ticketId, assignmentId, sessionId)
      },
      journal,
      metrics,
      redact,
      log: line => log.info(line),
      jobDelayMs: opts.jobDelayMs ?? 40,
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
    })
    const daemon = new Daemon(watchdog, line => log.info(line))
    return new Runtime({ home: opts.home, log, store, engine, harness, watchdog, daemon, model, metrics })
  }

  start(): void {
    this.daemon.start()
  }

  /** Ingress, then Engine.receive, then Eval for anything that was not a subscription bypass. */
  ingest(trigger: Trigger): ReceiveResult {
    if (this.store.getDoc<Trigger>('trigger', trigger.id)) {
      const result = this.engine.receive(trigger)
      this.log.info(`[engine] Intake.receive id=${trigger.id} result=${result}`)
      return result
    }
    const verdict = filterTrigger(trigger, this.model)
    if (verdict.action === 'pass') this.metrics.increment('ingress.admit')
    else this.metrics.increment('ingress.drop')
    this.log.info(
      `[ingress] two-level fast=${verdict.fast} semantic=${verdict.semantic} model=${this.model.name} action=${verdict.action} layer=${verdict.layer}`,
    )
    let incoming = trigger
    if (verdict.action === 'pass') {
      const recall = inlineOrSpill(trigger.text, body => this.store.putSpill(body))
      if (recall.spillId) {
        this.log.info(`[memory] Inline/Spill chain-of-recall spillId=${recall.spillId} bytes=${recall.bytes}`)
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
      // Gate runs before any worker. ignore, stop, and unavailable do not launch.
      if (decision.kind === 'accept' && decision.ticketId) {
        const ticket = this.store.getDoc<Ticket>('ticket', decision.ticketId)
        if (ticket) this.harness.launch(ticket)
      }
    }
    const disposition = this.store.getDoc<Disposition>('disposition', incoming.id)
    for (const ticketId of disposition?.fanout ?? []) this.harness.deliver(ticketId, incoming)
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
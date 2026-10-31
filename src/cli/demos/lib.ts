import fs from 'node:fs'
import path from 'node:path'
import {
  GhCliApi,
  GithubOutboxAdapter,
  githubRepoFromEnv,
  parseRepo,
  readGithubComment,
  type GithubApi,
  type GithubComment,
  type GithubRepoRef,
} from '../../channels/github-source.ts'
import { FeishuClient, FeishuOutboxAdapter, feishuConfigFromEnv } from '../../channels/feishu.ts'
import { Outbox, type OutboundAdapter } from '../../channels/outbox-adapter.ts'
import { requireLiveModelFromEnv, type Model } from '../../harness/model.ts'
import { resolveLiveApi } from '../../harness/providers.ts'
import { Runtime } from '../../runtime.ts'
import type { DomainEventName } from '../../shared/events.ts'
import type { JobRow, OutboxRow, ReplyRow, SessionRow, Ticket, Trigger } from '../../shared/types.ts'
import type { Store } from '../../store/sqlite.ts'

/**
 * Live-only demo harness for the Session C real-channel scenarios.
 *
 * There is no MockModel fallback and no in-memory fake IM/GitHub event pump:
 * each scenario pulls real GitHub issue/comment payloads through `gh api`,
 * runs the live model, and drains replies through a real outbox adapter.
 */

export const DEFAULT_LOG_DIR = '/tmp/ds-agent-live-e2e-logs/demos'

export function demoLogDir(): string {
  return process.env.DS_AGENT_DEMO_LOG_DIR ?? DEFAULT_LOG_DIR
}

export function demoModel(): Model {
  const live = resolveLiveApi()
  if (!live) {
    throw new Error(
      'These demos require a live OpenAI-compatible model. Set DS_AGENT_API_BASE and '
      + 'DS_AGENT_API_KEY (Magpie: http://127.0.0.1:3425/v1 + magpie). MockModel is forbidden.',
    )
  }
  const model = requireLiveModelFromEnv()
  // requireLiveModelFromEnv is typed to HttpOpenAI; this guard keeps the contract explicit.
  if ((model as { name?: string }).name !== 'HttpOpenAI') {
    throw new Error(`demoModel must be HttpOpenAI, got ${String((model as { name?: string }).name)}`)
  }
  return model
}

export interface DemoCheck {
  name: string
  ok: boolean
  detail?: string
}

export interface DemoContext {
  name: string
  home: string
  runtime: Runtime
  model: Model
  checks: DemoCheck[]
  startedAt: string
  runId: string
  logDir: string
  repo: GithubRepoRef
  github: GithubApi
  outbox: Outbox
}

export interface DemoOptions {
  jobDelayMs?: number
  watchdogIntervalMs?: number
  stuckMs?: number
  githubRepo?: GithubRepoRef
  runId?: string
  outboxIntervalMs?: number
}

export interface DemoSnapshot {
  tickets: Ticket[]
  sessions: SessionRow[]
  jobs: JobRow[]
  replies: ReplyRow[]
  outbox: OutboxRow[]
  events: { type: DomainEventName; payload: unknown; createdAt: string }[]
  metrics: unknown
}

export interface DemoSummary {
  name: string
  ok: boolean
  startedAt: string
  elapsedMs: number
  home: string
  logFile: string
  proofFile: string
  runId: string
  repo: string
  model: { name: string; provider: string; base: string; model: string }
  checks: DemoCheck[]
  snapshot: DemoSnapshot
  error?: string
}

export function check(ctx: DemoContext, name: string, ok: boolean, detail?: string): void {
  ctx.checks.push({ name, ok: Boolean(ok), detail })
  ctx.runtime.log.info(`[demo] check ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`)
}

export function checkEqual<T>(ctx: DemoContext, name: string, actual: T, expected: T): void {
  check(ctx, name, Object.is(actual, expected), `actual=${String(actual)} expected=${String(expected)}`)
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export type SettleOutcome =
  | { outcome: 'settled' }
  | { outcome: 'deadline' }
  | { outcome: 'failed'; error: string }

/** Wait for harness turns and async jobs, without letting a live model hang the demo. */
export async function settle(runtime: Runtime, ms = 120_000): Promise<SettleOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<SettleOutcome>(resolve => {
    timer = setTimeout(() => resolve({ outcome: 'deadline' }), ms)
  })
  const settled: Promise<SettleOutcome> = runtime.jobsSettled().then(
    () => ({ outcome: 'settled' as const }),
    error => ({ outcome: 'failed' as const, error: messageOf(error) }),
  )
  try {
    return await Promise.race([settled, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Poll a predicate until it returns a truthy value or the deadline expires. */
export async function waitFor<T>(
  predicate: () => T | undefined | false | Promise<T | undefined | false>,
  ms: number,
  intervalMs = 250,
): Promise<T | undefined> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() >= deadline) return undefined
    await sleep(intervalMs)
  }
}

export function snapshotStore(store: Store): DemoSnapshot {
  return {
    tickets: store.listDocs<Ticket>('ticket'),
    sessions: store.listSessions(),
    jobs: store.listJobs(),
    replies: store.listReplies(),
    outbox: store.listOutbox(),
    events: store.listEvents(),
    metrics: undefined,
  }
}

function safeSnapshot(store: Store): DemoSnapshot {
  const empty: DemoSnapshot = {
    tickets: [],
    sessions: [],
    jobs: [],
    replies: [],
    outbox: [],
    events: [],
    metrics: undefined,
  }
  if (!store.isOpen) return empty
  try {
    return snapshotStore(store)
  } catch {
    return empty
  }
}

export function ticketLine(ticket: Ticket): string {
  const assignment = ticket.assignments.at(-1)
  const report = assignment?.report ? ` report=${assignment.report.kind}` : ''
  const ended = ticket.ended ? ` ended=${ticket.ended.outcome}/${ticket.ended.by}` : ' ended=-'
  return `${ticket.id} assignment=${assignment?.state ?? '-'} session=${assignment?.workerSessionId ?? '-'}${report}${ended}`
}

export function sessionLine(session: SessionRow): string {
  return `${session.id} role=${session.role} status=${session.status} ticket=${session.ticketId ?? '-'}`
}

export function issueNumberForTicket(ticket: Ticket): number | undefined {
  const value = Number(ticket.channels[0]?.address?.issue)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

export function originTrigger(store: Store, ticket: Ticket): Trigger | undefined {
  return store.getDoc<Trigger>('trigger', ticket.originTriggerId)
}

export function outboxForTicket(store: Store, ticketId: string): OutboxRow[] {
  return store.listOutbox().filter(row => row.ticketId === ticketId)
}

export function sentOutboxForTicket(store: Store, ticketId: string): OutboxRow[] {
  return outboxForTicket(store, ticketId).filter(row => row.status === 'sent')
}

/**
 * Re-read a delivered GitHub comment from the API. This is the acceptance step
 * that proves outbound went through the real comment API, not the store alone.
 */
export async function verifyGithubOutbound(
  github: GithubApi,
  ticket: Ticket,
  store: Store,
): Promise<{ ok: boolean; detail: string; comment?: GithubComment }> {
  const sent = sentOutboxForTicket(store, ticket.id)
  const row = sent.find(item => item.channel === 'github' && item.externalId)
  if (!row?.externalId) {
    return { ok: false, detail: `no sent github outbox row for ${ticket.id}` }
  }
  try {
    const comment = await readGithubComment(github, row.externalId)
    const bodyOk = (comment.body ?? '').includes(row.text.split('\n')[0] ?? '') || (comment.body ?? '') === row.text
    return {
      ok: bodyOk,
      detail: `commentId=${comment.id} url=${comment.html_url ?? '-'} bytes=${(comment.body ?? '').length}`,
      comment,
    }
  } catch (error) {
    return { ok: false, detail: messageOf(error) }
  }
}

export async function closeGithubIssues(
  github: GithubApi,
  issues: { number: number }[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env.DS_AGENT_GH_KEEP === '1') return
  for (const issue of issues) {
    try {
      await github.updateIssue(issue.number, { state: 'closed' })
    } catch {
      // Closing is housekeeping; the demo proof is already written.
    }
  }
}

function currentGitHubUser(github: GithubApi): Promise<{ login?: string; type?: string }> {
  return github.request<{ login?: string; type?: string }>('user')
}

/**
 * Run one demo against the live model and real channels, always writing
 * `<name>.log` and `<name>.json` under the log directory, even when a check or
 * live turn throws.
 */
export async function runDemo(
  name: string,
  work: (ctx: DemoContext) => Promise<void>,
  options: DemoOptions = {},
): Promise<DemoSummary> {
  const logDir = demoLogDir()
  fs.mkdirSync(logDir, { recursive: true })
  const homeRoot = path.join(logDir, 'homes')
  fs.mkdirSync(homeRoot, { recursive: true })
  const home = fs.mkdtempSync(path.join(homeRoot, `${name}-`))
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  const runId = options.runId ?? `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`
  const live = resolveLiveApi()
  if (!live) throw new Error('live model configuration vanished before demo start')

  // Channel auth is checked before a Runtime exists so a misconfigured run fails fast.
  const repo = options.githubRepo ?? githubRepoFromEnv()
  const github = new GhCliApi(repo)
  let login = 'unknown'
  try {
    const user = await currentGitHubUser(github)
    login = user.login ?? 'unknown'
  } catch (error) {
    throw new Error(
      `real GitHub source requires an authenticated gh CLI (run "gh auth login"). ${messageOf(error)}`,
    )
  }

  const model = demoModel()
  const runtime = Runtime.create({
    home,
    model,
    jobDelayMs: options.jobDelayMs ?? 100,
    watchdogIntervalMs: options.watchdogIntervalMs ?? 60_000,
    stuckMs: options.stuckMs ?? 60_000,
  })

  const adapters: OutboundAdapter[] = [
    new GithubOutboxAdapter(github, line => runtime.log.info(line)),
  ]
  const feishu = feishuConfigFromEnv()
  if (feishu) {
    adapters.push(new FeishuOutboxAdapter(new FeishuClient(feishu), line => runtime.log.info(line)))
    runtime.log.info(`[demo] feishu outbound adapter configured base=${feishu.baseUrl} chat=${feishu.chatId ?? '-'}`)
  }
  const outbox = new Outbox(runtime.store, adapters, { log: line => runtime.log.info(line) })

  const ctx: DemoContext = {
    name,
    home,
    runtime,
    model,
    checks: [],
    startedAt,
    runId,
    logDir,
    repo,
    github,
    outbox,
  }
  runtime.log.info(`[demo] scenario=${name} runId=${runId} started=${startedAt}`)
  runtime.log.info(`[demo] model=${model.name} provider=${live.provider} base=${live.base} apiModel=${live.model} MockModel=forbidden`)
  runtime.log.info(`[demo] channel=github repo=${repo.full} actor=${login} issueApi=gh-api outbox=github-issue-comment`)
  runtime.log.info(`[demo] home=${home} logDir=${logDir}`)

  let thrown: unknown
  let snapshot = safeSnapshot(runtime.store)
  outbox.start(options.outboxIntervalMs ?? 400)
  try {
    await work(ctx)
  } catch (error) {
    thrown = error
    check(ctx, 'scenario completed without throwing', false, messageOf(error))
  } finally {
    outbox.stop()
    try {
      await outbox.flush()
    } catch (error) {
      runtime.log.info(`[outbox] final flush error ${messageOf(error)}`)
    }
    try {
      runtime.daemon.stop()
    } catch {
      // The daemon may already be stopped.
    }
    snapshot = safeSnapshot(runtime.store)
    snapshot.metrics = runtime.metrics.snapshot()
    // Give a late live turn a moment to observe the closed store instead of racing it.
    await sleep(50)
    if (runtime.store.isOpen) {
      try {
        runtime.store.close()
      } catch {
        // A live turn may still hold the handle.
      }
    }
    const elapsedMs = Date.now() - startedMs
    const ok = thrown == null && ctx.checks.length > 0 && ctx.checks.every(item => item.ok)
    runtime.log.info(`[demo] scenario=${name} ok=${ok} checks=${ctx.checks.filter(item => item.ok).length}/${ctx.checks.length} elapsedMs=${elapsedMs}`)
    const logFile = path.join(logDir, `${name}.log`)
    const proofFile = path.join(logDir, `${name}.json`)
    const summary: DemoSummary = {
      name,
      ok,
      startedAt,
      elapsedMs,
      home,
      logFile,
      proofFile,
      runId,
      repo: repo.full,
      model: { name: model.name, provider: live.provider, base: live.base, model: live.model },
      checks: ctx.checks,
      snapshot,
      ...(thrown == null ? {} : { error: messageOf(thrown) }),
    }
    fs.writeFileSync(logFile, `${runtime.log.text()}\n`)
    fs.writeFileSync(proofFile, `${JSON.stringify(summary, null, 2)}\n`)
    if (!ok) {
      const failures = ctx.checks.filter(item => !item.ok).map(item => item.name)
      throw new Error(
        `demo ${name} failed: ${failures.length > 0 ? failures.join(', ') : messageOf(thrown)} (log ${logFile})`,
      )
    }
    console.log(`[demo] ok ${name} log=${logFile} proof=${proofFile}`)
  }
  return {
    name,
    ok: true,
    startedAt,
    elapsedMs: Date.now() - startedMs,
    home,
    logFile: path.join(logDir, `${name}.log`),
    proofFile: path.join(logDir, `${name}.json`),
    runId,
    repo: repo.full,
    model: { name: model.name, provider: live.provider, base: live.base, model: live.model },
    checks: ctx.checks,
    snapshot,
  }
}

/** Count log lines containing `needle`. */
export function countLines(runtime: Runtime, needle: string): number {
  return runtime.log.lines.filter(line => line.includes(needle)).length
}

/** Match all log lines against a global regex and return the requested group. */
export function matchAll(runtime: Runtime, pattern: RegExp, group = 1): string[] {
  const out: string[] = []
  for (const line of runtime.log.lines) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
    const regex = new RegExp(pattern.source, flags)
    for (const match of line.matchAll(regex)) out.push(match[group] ?? '')
  }
  return out
}

export function entryPointIs(file: string): boolean {
  const entry = process.argv[1] ?? ''
  return entry.endsWith(`${file}.ts`) || entry.endsWith(`${file}.js`)
}

export { parseRepo }

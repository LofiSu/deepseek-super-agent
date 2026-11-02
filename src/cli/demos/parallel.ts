import { GithubIssueSource, type GithubIssue } from '../../channels/github-source.ts'
import type { Ticket } from '../../shared/types.ts'
import {
  check,
  checkEqual,
  closeGithubIssues,
  countLines,
  entryPointIs,
  issueNumberForTicket,
  matchAll,
  messageOf,
  originTrigger,
  runDemo,
  settle,
  ticketLine,
  verifyGithubOutbound,
  waitFor,
  type DemoContext,
} from './lib.ts'

/**
 * Scenario 1 — multi-task parallel from real GitHub issues.
 *
 * Three real issues are created on the configured repository, then pulled back
 * through the GitHub API. Their Triggers are admitted in one synchronous burst,
 * so three independent Tickets/ExecutorSessions are in flight before the first
 * live model reply. Each outbound Router reply is posted as a real issue
 * comment and re-read from the API as the acceptance proof.
 */

interface DemoTasks {
  label: string
}

const TASKS: DemoTasks[] = [
  { label: 'ALPHA' },
  { label: 'BETA' },
  { label: 'GAMMA' },
]

async function createRealIssue(ctx: DemoContext, label: string): Promise<GithubIssue> {
  const issue = await ctx.github.createIssue({
    title: `[ds-agent demo ${ctx.runId}] ${label} parallel task`,
    body: [
      `@ds-agent ${label} parallel demo task (independent from the other demo issues).`,
      `Use bash once to print ${label.toLowerCase()}.`,
      `Then call report_to_router with the ticketId from this task, kind=ready, deliver=true, text "${label} done".`,
      `Reply on this issue with exactly "${label} done".`,
      'Do not call start_job and do not ask questions.',
    ].join('\n'),
    labels: ['ds-agent-demo'],
  })
  ctx.runtime.log.info(`[github] created real issue #${issue.number} ${issue.html_url ?? ''}`)
  return issue
}

export async function runParallelDemo() {
  return runDemo('01-parallel-github', async ctx => {
    const { runtime, github, repo } = ctx
    runtime.start()

    // 1. Real GitHub activity: three independent issues.
    const issues: GithubIssue[] = []
    for (const task of TASKS) issues.push(await createRealIssue(ctx, task.label))
    check(ctx, 'three real GitHub issues created', issues.length === 3, issues.map(issue => `#${issue.number}`).join(','))

    // 2. Real Source pull: trigger text/actor/timestamps come from the API response.
    const pulls = await Promise.all(
      issues.map(issue => new GithubIssueSource(github, repo, issue.number).pull()),
    )
    for (const pull of pulls) {
      check(
        ctx,
        `pulled real issue #${pull.issue.number}`,
        pull.triggers.length >= 1 && pull.triggers[0]!.source === 'github',
        `triggers=${pull.triggers.length} title=${JSON.stringify(pull.issue.title)}`,
      )
    }

    // 3. One synchronous burst: every launch is registered before the first live turn.
    const triggers = pulls.map(pull => pull.triggers[0]!)
    for (const trigger of triggers) {
      const result = runtime.ingest(trigger)
      checkEqual(ctx, `ingest real trigger ${trigger.id}`, result, 'stored')
    }

    const tickets = runtime.store.listDocs<Ticket>('ticket')
    check(ctx, 'three independent tickets', tickets.length === 3, tickets.map(ticket => ticket.id).join(','))
    runtime.log.info(`[demo] tickets ${tickets.map(ticket => ticketLine(ticket)).join(' | ')}`)

    const sessionIds = tickets.map(ticket => ticket.assignments.at(-1)?.workerSessionId ?? '')
    check(
      ctx,
      'each ticket has a distinct worker session',
      new Set(sessionIds).size === 3 && sessionIds.every(Boolean),
      `sessions=${sessionIds.join(',')}`,
    )

    const started = tickets
      .map(ticket => Date.parse(ticket.assignments.at(-1)?.startedAt ?? ''))
      .filter(value => Number.isFinite(value))
    const spreadMs = started.length === 3 ? Math.max(...started) - Math.min(...started) : Number.NaN
    check(
      ctx,
      'all three assignments started in the same burst',
      started.length === 3 && spreadMs < 5_000,
      `startedAt spread=${spreadMs}ms`,
    )

    const workers = matchAll(runtime, /parallel workers=(\d+)/).map(Number)
    check(
      ctx,
      'harness observed three workers in flight',
      workers.length > 0 && Math.max(...workers) === 3,
      `parallel workers markers=${workers.join(',')}`,
    )

    for (const ticket of tickets) {
      const sessionId = `worker_${ticket.id}`
      check(
        ctx,
        `worker session started ${sessionId}`,
        countLines(runtime, `ExecutorSession start session=${sessionId}`) === 1,
      )
    }

    // 4. Every ticket must be tied to a real API issue, not a synthetic trigger.
    for (const ticket of tickets) {
      const origin = originTrigger(runtime.store, ticket)
      const issue = issueNumberForTicket(ticket)
      check(
        ctx,
        `ticket ${ticket.id} originated from real issue #${String(issue ?? '?')}`,
        origin?.source === 'github' && issue != null && issues.some(item => item.number === issue),
        `origin=${origin?.id ?? '-'} issue=${String(issue)}`,
      )
    }

    // 5. Wait for the live model to actually run in each worker session.
    const liveTurns = await waitFor(() => {
      const missing = tickets.filter(ticket => {
        const messages = runtime.store.listMessages(`worker_${ticket.id}`)
        return !messages.some(message => message.role === 'assistant')
      })
      return missing.length === 0 ? tickets : undefined
    }, 180_000, 500)
    check(
      ctx,
      'live model turn recorded in every worker session',
      liveTurns != null,
      tickets.map(ticket => {
        const messages = runtime.store.listMessages(`worker_${ticket.id}`)
        return `${ticket.id}:${messages.filter(message => message.role === 'assistant').length}`
      }).join(','),
    )

    const outcome = await settle(runtime, 150_000)
    check(ctx, 'live parallel turns settled', outcome.outcome === 'settled', outcome.outcome === 'failed' ? outcome.error : outcome.outcome)

    const latency = runtime.metrics.snapshot().modelLatencyMs
    check(ctx, 'live model calls observed', latency.count >= 3, `count=${latency.count} max=${latency.max}ms`)

    const reported = runtime.store.listDocs<Ticket>('ticket')
      .filter(ticket => ticket.assignments.at(-1)?.report != null).length
    check(ctx, 'live workers reported progress', reported >= 1, `reported=${reported}/${tickets.length}`)

    // 6. Real outbound: wait for the outbox adapter, then re-read each comment.
    const allSent = await waitFor(() => tickets.every(ticket =>
      runtime.store.listOutbox().some(row => row.ticketId === ticket.id && row.status === 'sent'),
    ), 20_000, 250)
    check(ctx, 'outbox delivered one reply per ticket', allSent != null, `outbox=${JSON.stringify(runtime.store.listOutbox().map(row => `${row.ticketId}:${row.status}`))}`)

    for (const ticket of tickets) {
      const issue = issueNumberForTicket(ticket)
      const proof = await verifyGithubOutbound(github, ticket, runtime.store)
      check(ctx, `real GitHub comment for #${String(issue ?? '?')} (${ticket.id})`, proof.ok, proof.detail)
    }

    const finalTickets = runtime.store.listDocs<Ticket>('ticket')
    runtime.log.info(`[demo] final ${finalTickets.map(ticket => ticketLine(ticket)).join(' | ')}`)

    await closeGithubIssues(github, issues)
    runtime.log.info(`[demo] issues ${issues.map(issue => `#${issue.number} ${issue.html_url ?? ''}`).join(' | ')}`)
  }, { jobDelayMs: 100 })
}

if (entryPointIs('parallel')) {
  runParallelDemo()
    .then(() => process.exit(0))
    .catch(error => {
      console.error(messageOf(error))
      process.exit(1)
    })
}

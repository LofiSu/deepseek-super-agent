import { GithubIssueSource } from '../../channels/github-source.ts'
import type { Ticket } from '../../shared/types.ts'
import {
  check,
  closeGithubIssues,
  countLines,
  entryPointIs,
  issueNumberForTicket,
  messageOf,
  originTrigger,
  runDemo,
  ticketLine,
  verifyGithubOutbound,
  waitFor,
} from './lib.ts'

/**
 * Scenario 3 — Watchdog path triggered by real GitHub activity.
 *
 * A real GitHub issue asks for a deliberately blocking reproduction (`sleep`).
 * The live worker starts, the daemon's watchdog sees a running assignment with
 * no report past `stuckMs`, nudges the ExecutorSession, then fails the assignment
 * on the next tick. The ack reply still leaves through the real GitHub comment
 * API, proving the outbound path stayed live.
 */

export async function runWatchdogDemo() {
  return runDemo('03-watchdog-github', async ctx => {
    const { runtime, github, repo } = ctx
    runtime.start()

    const issue = await github.createIssue({
      title: `[ds-agent demo ${ctx.runId}] watchdog stall`,
      body: [
        '@ds-agent Watchdog demo: reproduce the reported billing-worker hang.',
        'First call bash exactly once with command "sleep 60" and wait for it to return.',
        'Do not call report_to_router before bash returns.',
        'After bash returns, call report_to_router with kind=ready, deliver=false.',
        'Do not call start_job and do not ask questions.',
      ].join('\n'),
      labels: ['ds-agent-demo'],
    })
    runtime.log.info(`[github] created real issue #${issue.number} ${issue.html_url ?? ''}`)

    const pull = await new GithubIssueSource(github, repo, issue.number).pull()
    const trigger = pull.triggers[0]
    if (!trigger) {
      check(ctx, 'real issue produced a trigger', false, 'no trigger')
      return
    }
    check(ctx, 'real GitHub trigger pulled', trigger.source === 'github', `id=${trigger.id} chars=${trigger.text.length}`)
    const result = runtime.ingest(trigger)
    check(ctx, 'real GitHub trigger stored', result === 'stored', String(result))

    // The ExecutorSession must start before the watchdog can observe it.
    check(
      ctx,
      'worker session started from real GitHub activity',
      await waitFor(() => countLines(runtime, 'ExecutorSession start session=worker_') >= 1, 10_000, 100) != null,
    )

    const nudged = await waitFor(
      () => runtime.log.lines.find(line => line.includes('[watchdog] nudge')),
      15_000,
      100,
    )
    check(ctx, 'watchdog nudged the stuck real-channel worker', nudged != null, nudged ?? 'no nudge before deadline')

    const failed = await waitFor(
      () => runtime.log.lines.find(line => line.includes('[watchdog] fail')),
      15_000,
      100,
    )
    check(ctx, 'watchdog failed the stuck assignment on the next tick', failed != null, failed ?? 'no fail before deadline')

    const ticket = await waitFor(() => {
      const docs = runtime.store.listDocs<Ticket>('ticket')
      return docs.find(item => item.ended?.by === 'watchdog')
    }, 10_000, 100)
    check(ctx, 'ticket ended by watchdog', ticket != null, ticket ? ticketLine(ticket) : 'no watchdog-ended ticket')

    if (ticket) {
      const origin = originTrigger(runtime.store, ticket)
      const issueNumber = issueNumberForTicket(ticket)
      check(
        ctx,
        'watchdog ticket originated from the real GitHub issue',
        origin?.source === 'github' && issueNumber === issue.number,
        `origin=${origin?.id ?? '-'} issue=${String(issueNumber)} expected=#${issue.number}`,
      )
      check(
        ctx,
        'assignment report records the watchdog failure',
        ticket.assignments.at(-1)?.report?.kind === 'failed',
        `report=${ticket.assignments.at(-1)?.report?.kind ?? '-'}`,
      )
      const watchdogEvents = runtime.store.listEvents()
        .filter(event => event.type === 'watchdog.nudge' || event.type === 'watchdog.fail')
        .filter(event => (event.payload as { ticketId?: string }).ticketId === ticket.id)
      check(
        ctx,
        'durable watchdog.nudge + watchdog.fail events recorded',
        watchdogEvents.some(event => event.type === 'watchdog.nudge')
          && watchdogEvents.some(event => event.type === 'watchdog.fail'),
        watchdogEvents.map(event => event.type).join(','),
      )

      const ackSent = await waitFor(() => runtime.store.listOutbox().some(row =>
        row.ticketId === ticket.id && row.channel === 'github' && row.status === 'sent',
      ), 20_000, 250)
      check(ctx, 'outbox delivered the real GitHub acknowledgement', ackSent != null, `outbox=${runtime.store.listOutbox().map(row => row.status).join(',')}`)

      const proof = await verifyGithubOutbound(github, ticket, runtime.store)
      check(ctx, `real GitHub comment for #${issue.number}`, proof.ok, proof.detail)

      // The watchdog is the reason the ticket ended; a live model call still
      // proves the worker was real. Do not wait for the whole stalled turn.
      const latency = await waitFor(() => {
        const snapshot = runtime.metrics.snapshot().modelLatencyMs
        return snapshot.count >= 1 ? snapshot : undefined
      }, 30_000, 200)
      check(ctx, 'live model call recorded while the worker was stalled', latency != null, latency ? `count=${latency.count}` : 'no completed live call yet')
      check(
        ctx,
        'watchdog fail did not emit a speculative/result reply',
        runtime.store.listReplies().every(reply => reply.purpose !== 'result'),
        runtime.store.listReplies().map(reply => reply.purpose).join(','),
      )

      // Let the in-flight live turn reject/settle harmlessly after the snapshot.
      void runtime.jobsSettled().catch(() => undefined)
    }

    await closeGithubIssues(github, [issue])
  }, { jobDelayMs: 100, watchdogIntervalMs: 150, stuckMs: 400 })
}

if (entryPointIs('watchdog')) {
  runWatchdogDemo()
    .then(() => process.exit(0))
    .catch(error => {
      console.error(messageOf(error))
      process.exit(1)
    })
}

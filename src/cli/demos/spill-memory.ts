import { GithubIssueSource, type GithubIssue } from '../../channels/github-source.ts'
import { readSpillFor } from '../../memory/acl.ts'
import type { Ticket, Trigger } from '../../shared/types.ts'
import {
  check,
  checkEqual,
  closeGithubIssues,
  countLines,
  entryPointIs,
  issueNumberForTicket,
  messageOf,
  runDemo,
  settle,
  ticketLine,
  verifyGithubOutbound,
  waitFor,
} from './lib.ts'

/**
 * Scenario 2 — long dialog Inline/Spill over a real GitHub comment thread.
 *
 * A real issue body plus two real comments exceed INLINE_LIMIT. The Source
 * pulls those API bodies, the Runtime replaces each long input with a short
 * inline summary + spill id, and the live worker must recall the spilled fact
 * with read_object. The Router's reply is posted back as a real issue comment.
 */

const KNOWN_GOOD = 'abc123def'
const ROLLBACK = 'release-9.7'

function samples(count: number): string {
  return Array.from({ length: count }, (_, index) =>
    `sample ${index + 1}: checkout p99 4.2s queue depth ${120 + index} worker billing-${index + 1}`,
  ).join('. ')
}

// The known-good commit sits after the 72-char inline summary but inside the
// first 200-char read_object page, so recall is genuinely required.
const TURN_1 = [
  '@ds-agent INCIDENT-42 triage note. The failing service is billing-worker in us-east-1.',
  `The last known good commit is ${KNOWN_GOOD}.`,
  'Checkout latency p99 rose to 4.2s after deploy 2026-10-31T22:10Z.',
  samples(8),
].join(' ')

const TURN_2 = [
  'INCIDENT-42 update for the long dialog. The rollback target is release-9.7.',
  'The error signature is SQLSTATE 40001 serialization failure on the billing ledger.',
  `Confirm both ids: rollback=${ROLLBACK} and last-known-good=${KNOWN_GOOD}.`,
  'This update is long on purpose so the second message also spills.',
  samples(8),
].join(' ')

const TURN_3 = '@ds-agent From the spilled INCIDENT-42 context, reply with the last known good commit id only.'

export async function runSpillMemoryDemo() {
  return runDemo('02-spill-github', async ctx => {
    const { runtime, github, repo } = ctx
    runtime.start()

    // 1. Real GitHub activity: one issue body + two real comments.
    const issue = await github.createIssue({
      title: `[ds-agent demo ${ctx.runId}] INCIDENT-42 spill`,
      body: TURN_1,
      labels: ['ds-agent-demo'],
    })
    const second = await github.createIssueComment(issue.number, TURN_2)
    const third = await github.createIssueComment(issue.number, TURN_3)
    runtime.log.info(`[github] created real issue #${issue.number} ${issue.html_url ?? ''}`)
    runtime.log.info(`[github] created real comments #${second.id} #${third.id}`)

    // 2. Pull the real Source. Trigger text is the API's title/body/comment text.
    const pull = await new GithubIssueSource(github, repo, issue.number).pull()
    check(ctx, 'pulled real issue plus two real comments', pull.triggers.length === 3, `triggers=${pull.triggers.map(trigger => trigger.id).join(',')}`)
    const [firstTrigger, secondTrigger, thirdTrigger] = pull.triggers
    if (!firstTrigger || !secondTrigger || !thirdTrigger) {
      check(ctx, 'three real triggers present', false, 'missing a trigger')
      return
    }
    check(ctx, 'first real body exceeds the inline limit', firstTrigger.text.length > 180, `chars=${firstTrigger.text.length}`)
    check(ctx, 'second real body exceeds the inline limit', secondTrigger.text.length > 180, `chars=${secondTrigger.text.length}`)
    check(ctx, 'third real body stays inline', thirdTrigger.text.length <= 180, `chars=${thirdTrigger.text.length}`)
    check(ctx, 'real GitHub actor is human', firstTrigger.human && secondTrigger.human && thirdTrigger.human, `actors=${[firstTrigger, secondTrigger, thirdTrigger].map(trigger => trigger.actor.id).join(',')}`)

    // 3. Synchronous dialog: turn 1 opens the ticket; turns 2-3 take the
    // subscription bypass before any live turn can end it.
    const results = [
      runtime.ingest(firstTrigger),
      runtime.ingest(secondTrigger),
      runtime.ingest(thirdTrigger),
    ]
    check(ctx, 'all three real dialog turns stored', results.every(result => result === 'stored'), `results=${results.join(',')}`)

    const tickets = runtime.store.listDocs<Ticket>('ticket')
    checkEqual(ctx, 'one ticket for the whole real dialog', tickets.length, 1)
    const ticket = tickets[0]
    if (!ticket) {
      check(ctx, 'ticket present', false, 'no ticket was created')
      return
    }
    runtime.log.info(`[demo] ticket ${ticketLine(ticket)}`)

    checkEqual(ctx, 'two bypass follow-ups joined the ticket', ticket.inputs.length, 3)
    const spillIds = [...new Set(ticket.inputs.map(input => input.spillId).filter((id): id is string => Boolean(id)))]
    checkEqual(ctx, 'two long real turns spilled', spillIds.length, 2)
    check(
      ctx,
      'short real follow-up did not spill',
      ticket.inputs[2]?.spillId == null && ticket.inputs[2]?.text === thirdTrigger.text,
      `input3Spill=${String(ticket.inputs[2]?.spillId)}`,
    )

    const bodies = new Map(spillIds.map(id => [id, runtime.store.getSpill(id)]))
    const bodyValues = [...bodies.values()]
    check(ctx, 'spill bodies survived in SQLite', spillIds.every(id => bodies.get(id) != null))
    check(ctx, 'first spill body is the real first GitHub payload', bodyValues.includes(firstTrigger.text), `sizes=${bodyValues.map(body => body?.length ?? -1).join(',')}`)
    check(ctx, 'second spill body is the real second GitHub comment', bodyValues.includes(secondTrigger.text))

    const firstSpill = spillIds[0]
    if (firstSpill) {
      // The trigger row holds only the inline summary, not the spilled body.
      const stored = runtime.store.getDoc<Trigger>('trigger', firstTrigger.id)
      check(
        ctx,
        'trigger row stored an inline summary plus spill id',
        stored != null
          && stored.text.includes(`spillId=${firstSpill}`)
          && stored.text.length < firstTrigger.text.length
          && !stored.text.includes('queue depth'),
        `inlineChars=${stored?.text.length ?? -1} bodyChars=${firstTrigger.text.length}`,
      )

      // Page-wise recall reassembles the original body exactly.
      let offset = 0
      let reassembled = ''
      let pages = 0
      const firstPage = readSpillFor(runtime.store, firstSpill, { ticketId: ticket.id }, { offset: 0 })
      check(
        ctx,
        'first read_object page carries the known-good commit',
        firstPage.text.includes(KNOWN_GOOD),
        `pageChars=${firstPage.text.length} total=${firstPage.total}`,
      )
      for (;;) {
        const page = readSpillFor(runtime.store, firstSpill, { ticketId: ticket.id }, { offset })
        pages += 1
        reassembled += page.text
        if (page.nextOffset == null) break
        offset = page.nextOffset
        if (pages > 50) break
      }
      check(ctx, 'read_object pages reassemble the real first payload', reassembled === firstTrigger.text, `pages=${pages} chars=${reassembled.length}`)

      let denied = ''
      try {
        readSpillFor(runtime.store, firstSpill, { sessionId: 'worker_someone_else' })
      } catch (error) {
        denied = messageOf(error)
      }
      check(ctx, 'ungranted session cannot read the spill', denied.includes('not visible'), denied.slice(0, 120))
    }

    check(ctx, 'two chain-of-recall memories logged', countLines(runtime, '[memory] Inline/Spill chain-of-recall spillId=') >= 2)
    check(ctx, 'two subscription bypasses logged', countLines(runtime, 'bypass=subscription') >= 2)

    // 4. Real outbound acknowledgement.
    const ackSent = await waitFor(() => runtime.store.listOutbox().some(row =>
      row.ticketId === ticket.id && row.channel === 'github' && row.status === 'sent',
    ), 20_000, 250)
    check(ctx, 'outbox delivered the acknowledgement', ackSent != null, `outbox=${runtime.store.listOutbox().map(row => row.status).join(',')}`)

    // 5. Live worker recall.
    const recalled = await waitFor(() => {
      const messages = runtime.store.listMessages(`worker_${ticket.id}`)
      return messages.some(message => message.body.includes('"name":"read_object"') && message.body.includes(KNOWN_GOOD))
        ? messages
        : undefined
    }, 180_000, 500)
    check(
      ctx,
      'live worker recalled the known-good commit through read_object',
      recalled != null,
      recalled ? `rows=${recalled.length}` : 'no read_object result carried the commit before the deadline',
    )

    const outcome = await settle(runtime, 120_000)
    check(ctx, 'live dialog turns settled', outcome.outcome === 'settled', outcome.outcome === 'failed' ? outcome.error : outcome.outcome)

    const messages = runtime.store.listMessages(`worker_${ticket.id}`)
    const assistant = messages.filter(message => message.role === 'assistant').length
    check(ctx, 'live model turn recorded', assistant >= 1, `assistant=${assistant} rows=${messages.length}`)

    const reads = messages.filter(message => message.body.includes('"name":"read_object"'))
    check(ctx, 'live worker called read_object', reads.length >= 1, `read_object tool results=${reads.length}`)

    const recallTotals = runtime.log.lines
      .map(line => /\[memory\] read_object id=(spill_\d+) bytes=(\d+) total=(\d+)/.exec(line))
      .filter((match): match is RegExpExecArray => match != null)
      .map(match => ({ id: match[1], total: Number(match[3]) }))
    check(
      ctx,
      'read_object page size stops at 200 chars',
      recallTotals.length > 0 && recallTotals.every(entry => entry.total > 200),
      `reads=${recallTotals.map(entry => `${entry.id}:${entry.total}`).join(',')}`,
    )

    const latency = runtime.metrics.snapshot().modelLatencyMs
    check(ctx, 'live model calls observed', latency.count >= 1, `count=${latency.count} max=${latency.max}ms`)

    // 6. Real outbound proof: re-read the posted comment from GitHub.
    const proof = await verifyGithubOutbound(github, ticket, runtime.store)
    check(ctx, `real GitHub comment for #${String(issueNumberForTicket(ticket) ?? '?')}`, proof.ok, proof.detail)

    runtime.log.info(`[demo] spills=${spillIds.join(',')} session=worker_${ticket.id} replies=${runtime.store.listReplies().length}`)

    await closeGithubIssues(github, [issue as GithubIssue])
  }, { jobDelayMs: 100 })
}

if (entryPointIs('spill-memory')) {
  runSpillMemoryDemo()
    .then(() => process.exit(0))
    .catch(error => {
      console.error(messageOf(error))
      process.exit(1)
    })
}

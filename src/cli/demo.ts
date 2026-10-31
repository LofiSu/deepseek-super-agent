import fs from 'node:fs'
import path from 'node:path'
import { githubTrigger } from '../channels/github.ts'
import { imTrigger } from '../channels/im.ts'
import { requireLiveModelFromEnv, type Model } from '../harness/model.ts'
import { resolveLiveApi } from '../harness/providers.ts'
import { Runtime } from '../runtime.ts'
import type { Ticket } from '../shared/types.ts'
import { Store } from '../store/sqlite.ts'

/** Engine-side markers required for the live Magpie/DeepSeek demo. */
export const LIVE_DEMO_PROOFS = [
  'model=HttpOpenAI',
  'two-level',
  'Intake.receive',
  'noise dropped',
  'Tickets.create',
  'Assignments.start',
  'bypass=subscription',
  'restart persistence',
]

/** @deprecated Demo always uses a live model; kept as an alias for LIVE_DEMO_PROOFS. */
export const DEMO_PROOFS = LIVE_DEMO_PROOFS

export function defaultHome(): string {
  return process.env.DS_AGENT_HOME ?? path.join(process.cwd(), '.ds-agent')
}

/**
 * Always returns a live HttpOpenAI. Refuses MockModel when no provider is configured.
 */
export function demoModel(env: NodeJS.ProcessEnv = process.env): { model: Model; provider: string | null } {
  const live = resolveLiveApi(env)
  if (!live) {
    throw new Error(
      'pnpm demo requires a live model (set DS_AGENT_API_BASE + DS_AGENT_API_KEY, or a provider key). MockModel is forbidden.',
    )
  }
  const model: Model = requireLiveModelFromEnv(env)
  if (model.name === 'MockModel') {
    throw new Error('pnpm demo must not use MockModel')
  }
  return { model, provider: live.provider }
}

export async function runDemo(home = defaultHome()): Promise<void> {
  const selected = demoModel()
  const model = selected.model
  fs.rmSync(home, { recursive: true, force: true })
  const runtime = Runtime.create({
    home,
    model,
    jobDelayMs: 250,
    watchdogIntervalMs: 250,
    stuckMs: 60_000,
  })
  runtime.log.info('ds-agent demo')
  runtime.log.info('not an official DeepSeek product')
  runtime.log.info(
    `demo model=${model.name} provider=${selected.provider} (live Magpie/DeepSeek; MockModel forbidden)`,
  )
  runtime.start()
  try {
    runtime.ingest(imTrigger({
      id: 'trg_noise',
      thread: 'topic/chatter',
      text: 'lol nice weather today haha',
      actor: 'sam',
      addressed: false,
    }))
    runtime.ingest(imTrigger({
      id: 'trg_soft',
      thread: 'topic/chatter',
      text: 'circling back on the notes from yesterday standup, sharing for visibility only',
      actor: 'sam',
      addressed: false,
    }))
    runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout on checkout',
      actor: 'alex',
    }))
    runtime.ingest(imTrigger({
      id: 'trg_login_2',
      thread: 'topic/bug-login',
      text: '@ds-agent login still 500, the timeout is back',
      actor: 'alex',
    }))
    const trace = `CI failed on auth test. expected 200 got 500 at login. ${'frame at auth/session.ts '.repeat(12)}`
    runtime.ingest(githubTrigger({
      id: 'trg_pr42',
      pr: 42,
      text: trace,
      actor: 'ci-bot',
    }))
    runtime.ingest(githubTrigger({
      id: 'trg_maybe',
      pr: 99,
      text: 'might be a flaky payment test, not sure it is ours',
      speculate: true,
    }))
    await runtime.watchdogTurn()
    // Live models may keep scheduling bash/start_job; cap wait so demo exits.
    runtime.daemon.stop()
    {
      let timer: ReturnType<typeof setTimeout> | undefined
      const settled = runtime.jobsSettled().then(
        () => 'settled' as const,
        () => 'failed' as const,
      )
      const deadline = new Promise<'deadline'>(resolve => {
        timer = setTimeout(() => resolve('deadline'), 45_000)
      })
      try {
        const outcome = await Promise.race([settled, deadline])
        runtime.log.info(`jobsSettled outcome=${outcome}`)
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    const before = runtime.store.listDocs<Ticket>('ticket')
    runtime.log.info(
      `pre-restart tickets=${before.length} ids=${before.map(ticket => ticket.id).join(',')}`,
    )
    // Snapshot while open; avoid close() racing leftover live turns.
    const beforeIds = before.map(ticket => ticket.id).sort().join(',')
    if (before.length < 3) {
      throw new Error(`expected >=3 tickets before restart check, got ${before.length}`)
    }
    try {
      runtime.store.close()
    } catch (error) {
      runtime.log.info(`store close skipped: ${error instanceof Error ? error.message : error}`)
    }
    const reopened = new Store(home)
    try {
      const tickets = reopened.listDocs<Ticket>('ticket')
      const jobs = reopened.listJobs()
      runtime.log.info(
        `restart persistence ok tickets=${tickets.length} ids=${tickets.map(ticket => ticket.id).join(',')} jobs=${jobs.length}`,
      )
      const afterIds = tickets.map(ticket => ticket.id).sort().join(',')
      if (tickets.length < 3 || afterIds !== beforeIds) {
        throw new Error(`restart lost tickets: before=${before.length} after=${tickets.length}`)
      }
    } finally {
      reopened.close()
    }
  } finally {
    if (runtime.store.isOpen) {
      runtime.daemon.stop()
      runtime.store.close()
    }
  }
  const missing = LIVE_DEMO_PROOFS.filter(needle => !runtime.log.lines.some(line => line.includes(needle)))
  if (missing.length > 0) {
    throw new Error(`missing proofs: ${missing.join(', ')}`)
  }
  runtime.log.info('demo ok (live model)')
}

const entry = process.argv[1] ?? ''
if (entry.endsWith('demo.ts') || entry.endsWith('demo.js')) {
  runDemo()
    .then(() => {
      // Live turns may still hold the event loop; exit after proofs pass.
      process.exit(0)
    })
    .catch(error => {
      console.error(error instanceof Error ? error.stack ?? error.message : error)
      process.exit(1)
    })
}

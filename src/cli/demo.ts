import fs from 'node:fs'
import path from 'node:path'
import { githubTrigger } from '../channels/github.ts'
import { imTrigger } from '../channels/im.ts'
import { MockModel } from '../harness/model.ts'
import { Runtime } from '../runtime.ts'
import type { Ticket } from '../shared/types.ts'
import { Store } from '../store/sqlite.ts'

export const DEMO_PROOFS = [
  'model=MockModel',
  'RouterSession',
  'WorkerSession',
  'dual-layer',
  'two-level',
  'layer=fast',
  'layer=semantic',
  'noise dropped',
  'Intake.receive',
  'Evals.batch',
  'Tickets.create',
  'Assignments.start',
  'bypass=subscription',
  'ticketId=',
  'parallel workers',
  'spillId=',
  'read_object',
  'speculative silent',
  'deliver=true',
  'async job started',
  '[watchdog] tick',
  'purpose=acknowledgement',
  'purpose=result',
  'restart persistence',
]

export function defaultHome(): string {
  return process.env.DS_AGENT_HOME ?? path.join(process.cwd(), '.ds-agent')
}

export async function runDemo(home = defaultHome()): Promise<void> {
  fs.rmSync(home, { recursive: true, force: true })
  const runtime = Runtime.create({
    home,
    model: new MockModel(),
    jobDelayMs: 30,
    watchdogIntervalMs: 20,
    stuckMs: 60_000,
  })
  runtime.log.info('ds-agent demo')
  runtime.log.info('not an official DeepSeek product')
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
    await runtime.jobsSettled()
    const before = runtime.store.listDocs<Ticket>('ticket')
    runtime.daemon.stop()
    runtime.store.close()
    const reopened = new Store(home)
    try {
      const tickets = reopened.listDocs<Ticket>('ticket')
      const jobs = reopened.listJobs()
      runtime.log.info(
        `restart persistence ok tickets=${tickets.length} ids=${tickets.map(ticket => ticket.id).join(',')} jobs=${jobs.length}`,
      )
      if (tickets.length !== before.length || tickets.length < 3) {
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
  const missing = DEMO_PROOFS.filter(needle => !runtime.log.lines.some(line => line.includes(needle)))
  if (missing.length > 0) {
    throw new Error(`missing proofs: ${missing.join(', ')}`)
  }
  runtime.log.info('demo ok')
}

const entry = process.argv[1] ?? ''
if (entry.endsWith('demo.ts') || entry.endsWith('demo.js')) {
  runDemo().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exitCode = 1
  })
}

import { githubTrigger } from '../channels/github.ts'
import { cliTrigger } from '../channels/cli.ts'
import { imTrigger } from '../channels/im.ts'
import { ticketStage } from '../core/stage.ts'
import { createModelFromEnv } from '../harness/model.ts'
import { Runtime } from '../runtime.ts'
import type { JobRow, SessionRow, Ticket } from '../shared/types.ts'
import { Store } from '../store/sqlite.ts'
import { defaultHome, runDemo } from './demo.ts'

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  return process.argv[index + 1]
}

function help(): void {
  console.log(`ds-agent — local super-agent demo (not an official DeepSeek product)

  pnpm demo
  pnpm ds-agent init
  pnpm ds-agent tasks
  pnpm ds-agent status
  pnpm ds-agent chat "fix the login timeout"
  pnpm ds-agent emit im --thread bug-login --text "login still 500"
  pnpm ds-agent emit github --pr 42 --text "CI failed on auth test"

State lives in DS_AGENT_HOME or ./.ds-agent (SQLite).
Cloud model: DS_AGENT_API_BASE + DS_AGENT_API_KEY (optional DS_AGENT_MODEL).
The demo always uses MockModel.`)
}

async function withRuntime(work: (runtime: Runtime) => Promise<void> | void): Promise<void> {
  const runtime = Runtime.create({
    home: defaultHome(),
    model: createModelFromEnv(),
    jobDelayMs: 20,
    watchdogIntervalMs: 60_000,
  })
  runtime.start()
  try {
    await work(runtime)
    await runtime.finish()
  } finally {
    if (runtime.store.isOpen) {
      runtime.daemon.stop()
      runtime.store.close()
    }
  }
}

async function main(): Promise<void> {
  const [cmd, sub] = process.argv.slice(2)
  const home = defaultHome()
  if (!cmd || cmd === 'help' || cmd === '--help') {
    help()
    return
  }
  if (cmd === 'demo') {
    await runDemo(home)
    console.log('demo ok')
    return
  }
  if (cmd === 'init') {
    const store = new Store(home)
    store.close()
    console.log(`initialized ${home}`)
    return
  }
  if (cmd === 'tasks') {
    const store = new Store(home)
    const tickets = store.listDocs<Ticket>('ticket')
    if (tickets.length === 0) console.log('no tickets')
    for (const ticket of tickets) console.log(`${ticket.id}\t${ticketStage(ticket)}\t${ticket.title}`)
    store.close()
    return
  }
  if (cmd === 'status') {
    const store = new Store(home)
    const sessions = store.listSessions()
    const jobs = store.listJobs()
    console.log(`db ${store.path}`)
    console.log(`sessions ${sessions.length}`)
    for (const session of sessions) console.log(`  ${sessionLine(session)}`)
    console.log(`jobs ${jobs.length}`)
    for (const job of jobs) console.log(`  ${jobLine(job)}`)
    console.log(`tickets ${store.listDocs<Ticket>('ticket').length}`)
    store.close()
    return
  }
  if (cmd === 'chat') {
    const text = process.argv.slice(3).filter(part => !part.startsWith('--')).join(' ').trim()
    if (!text) throw new Error('chat needs text')
    await withRuntime(runtime => { runtime.ingest(cliTrigger({ text })) })
    return
  }
  if (cmd === 'emit' && sub === 'im') {
    const thread = option('thread') ?? 'topic/general'
    const text = option('text')
    if (!text) throw new Error('emit im needs --text')
    await withRuntime(runtime => {
      runtime.ingest(imTrigger({ thread, text, addressed: option('mention') !== 'false' }))
    })
    return
  }
  if (cmd === 'emit' && sub === 'github') {
    const pr = Number(option('pr') ?? '0')
    const text = option('text')
    if (!text || !Number.isFinite(pr) || pr <= 0) throw new Error('emit github needs --pr and --text')
    await withRuntime(runtime => {
      runtime.ingest(githubTrigger({ pr, text, speculate: option('speculate') === 'true' }))
    })
    return
  }
  throw new Error(`unknown command ${cmd}`)
}

function sessionLine(session: SessionRow): string {
  return `${session.id} role=${session.role} status=${session.status} ticket=${session.ticketId ?? '-'}`
}

function jobLine(job: JobRow): string {
  return `${job.id} status=${job.status} ticket=${job.ticketId} name=${job.name}`
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

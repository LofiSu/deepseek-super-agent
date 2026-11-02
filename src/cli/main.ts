import { githubTrigger } from '../channels/github.ts'
import { cliTrigger } from '../channels/cli.ts'
import { imTrigger } from '../channels/im.ts'
import { Engine } from '../core/engine.ts'
import type { Host } from '../core/host.ts'
import { ticketStage } from '../core/stage.ts'
import { createModelFromEnv, requireLiveModelFromEnv, type Model } from '../harness/model.ts'
import { aggregateReportOf, describeTopologyOf, type TeamRecord } from '../harness/team.ts'
import { formatMetricsJson, Metrics } from '../metrics/metrics.ts'
import type { A2AEnvelope } from '../channels/a2a.ts'
import type { LongTermMemoryEntry } from '../memory/long-term.ts'
import { Runtime } from '../runtime.ts'
import { visibleTickets } from '../speculate/index.ts'
import type { JobRow, SessionRow, Ticket } from '../shared/types.ts'
import { Store } from '../store/sqlite.ts'
import { healthProbe } from '../watchdog/health.ts'
import { defaultHome, runDemo } from './demo.ts'

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  return process.argv[index + 1]
}

/** Positional arguments after `start`, skipping flags (and the value of a value-flag). */
function bare(start: number, valueFlags: readonly string[] = []): string[] {
  const out: string[] = []
  const args = process.argv.slice(start)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg.startsWith('--')) {
      if (!arg.includes('=') && valueFlags.includes(arg.slice(2))) index += 1
      continue
    }
    out.push(arg)
  }
  return out
}

function meshCapacity(): number {
  const n = Number(process.env.DS_AGENT_MESH_CAPACITY)
  return Number.isSafeInteger(n) && n > 0 ? n : 4
}

function resolveTicket(store: Store, raw: string | undefined): Ticket {
  const all = store.listDocs<Ticket>('ticket')
  const live = all.filter(ticket => !ticket.ended)
  const hint = live.length > 0
    ? live.map(ticket => `${ticket.id} (${ticketStage(ticket)})`).join(', ')
    : 'none'
  if (!raw) throw new Error(`ticket id required; live tickets: ${hint}`)
  if (raw === 'latest') {
    const latest = [...live].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1)
    if (!latest) throw new Error('no live ticket to select')
    return latest
  }
  const exact = all.find(ticket => ticket.id === raw)
  if (exact) return exact
  const matches = all.filter(ticket => ticket.id.startsWith(raw))
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    throw new Error(`ambiguous ticket ${raw}; matches: ${matches.map(ticket => ticket.id).join(', ')}`)
  }
  throw new Error(`unknown ticket ${raw}; live tickets: ${hint}`)
}

/**
 * Offline engine for pause/intervene/collab. These commands only touch SQLite,
 * so they never construct a model (and never fall back to MockModel).
 */
function withEngine<T>(
  work: (engine: Engine, store: Store) => T,
  opts: { verbose?: boolean } = {},
): T {
  const home = defaultHome()
  const store = new Store(home)
  const metrics = new Metrics(home)
  const host: Host = {
    repo: store,
    now: () => new Date().toISOString(),
    metrics,
    log: line => {
      if (opts.verbose) console.error(line)
    },
    scope: { admit: () => ({ listened: true, reason: 'cli' }) },
  }
  const engine = new Engine(host)
  try {
    return work(engine, store)
  } finally {
    store.close()
  }
}

function help(): void {
  console.log(`ds-agent — local super-agent demo (not an official DeepSeek product)

  pnpm demo                 real GitHub issues/comments + live model (acceptance)
  pnpm demo -- --only watchdog
  pnpm demo:local           in-memory fixture baseline (not channel acceptance)
  pnpm demo:feishu          real Feishu message API smoke (needs app creds)
  pnpm ds-agent init
  pnpm ds-agent tasks
  pnpm ds-agent status
  pnpm ds-agent health
  pnpm ds-agent chat "fix the login timeout"
  pnpm ds-agent emit im --thread bug-login --text "login still 500"
  pnpm ds-agent emit github --pr 42 --text "CI failed on auth test"
  pnpm ds-agent metrics
  pnpm ds-agent memory [--limit 10]   # persisted cross-ticket memories
  pnpm ds-agent a2a [--limit 10]      # persisted A2A envelopes

Mid-task collaboration (persisted in SQLite):
  pnpm ds-agent pause <ticketId> [--reason "waiting on staging"]
  pnpm ds-agent intervene <ticketId> "use the staging db" [--no-pause]
  pnpm ds-agent resume <ticketId> [--reason "human verified"]
  pnpm ds-agent collab <ticketId>          # pause state + guidance audit
  <ticketId> accepts an exact id, a unique prefix, or "latest".

Worker-internal teams (persisted in SQLite, offline reads):
  pnpm ds-agent team <teamId|ticketId>     # topology, aggregate, member status
  pnpm ds-agent teams [--ticket <id>] [--session <id>]  # list teams
  <teamId> accepts an exact id or a unique prefix.

pause freezes Router/Worker turns, reports, and outbound replies.
intervene records guidance and pauses by default, so the note lands before more work.
resume clears the pause and continues with the unseen guidance in the next turn.
resume needs a live model; pause/intervene/collab/team/teams are offline.

State lives in DS_AGENT_HOME or ./.ds-agent (SQLite).
Section 7 counters are written to <stateDir>/metrics.json and printed by metrics.
Cloud model: DS_AGENT_API_BASE + DS_AGENT_API_KEY (optional DS_AGENT_API_MODEL),
or one provider key: DEEPSEEK_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY,
XAI_API_KEY / GROK_API_KEY, MOONSHOT_API_KEY / KIMI_API_KEY, ZHIPU_API_KEY / GLM_API_KEY,
GEMINI_API_KEY / GOOGLE_API_KEY, ANTHROPIC_API_KEY.
Optional DS_AGENT_PROVIDER picks a preset when several keys are set.
pnpm demo always requires a live model and authenticated gh (MockModel/fake IM/GitHub forbidden).
Real GitHub repo: DS_AGENT_GH_REPO (default LofiSu/deepseek-super-agent).
A half-set DS_AGENT_API_BASE/KEY fails instead of falling back.`)
}

async function withRuntime(
  work: (runtime: Runtime) => Promise<void> | void,
  model?: Model,
): Promise<void> {
  const runtime = Runtime.create({
    home: defaultHome(),
    model: model ?? createModelFromEnv(),
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
    // Legacy local fixture flow. `pnpm demo` is the real-channel acceptance runner.
    await runDemo(home)
    console.log('demo:local ok (fixture baseline; use pnpm demo for real channels)')
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
    const tickets = visibleTickets(store.listDocs<Ticket>('ticket'))
    if (tickets.length === 0) console.log('no tickets')
    for (const ticket of tickets) console.log(`${ticket.id}\t${ticketStage(ticket)}\t${ticket.title}`)
    store.close()
    return
  }
  if (cmd === 'health') {
    const store = new Store(home)
    try {
      console.log(JSON.stringify(healthProbe(store, home)))
    } finally {
      store.close()
    }
    return
  }
  if (cmd === 'metrics') {
    console.log(formatMetricsJson(home))
    return
  }
  if (cmd === 'memory' || cmd === 'a2a') {
    const limit = Math.max(1, Number(option('limit') ?? 10) || 10)
    const store = new Store(home)
    try {
      const instance = process.env.DS_AGENT_INSTANCE_ID ?? 'local'
      if (cmd === 'memory') {
        const memories = store.listDocs<LongTermMemoryEntry>('ltm')
        console.log(JSON.stringify({
          instance,
          meshCapacity: meshCapacity(),
          memories: memories.length,
          recent: memories.slice(-limit).map(entry => ({
            id: entry.id,
            ticketId: entry.ticketId,
            text: entry.text,
          })),
        }, null, 2))
      } else {
        const envelopes = store.listDocs<A2AEnvelope>('a2a')
        console.log(JSON.stringify({
          instance,
          envelopes: envelopes.length,
          recent: envelopes.slice(-limit).map(envelope => ({
            id: envelope.id,
            from: envelope.from,
            to: envelope.to,
          })),
        }, null, 2))
      }
    } finally {
      store.close()
    }
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
  if (cmd === 'team') {
    const ref = bare(3)[0]
    const store = new Store(home)
    try {
      const teams = store.listDocs<TeamRecord>('team')
      if (!ref) {
        if (teams.length === 0) console.log('no teams')
        for (const team of teams) console.log(teamLine(team))
        return
      }
      const byId = uniqueTeam(teams, ref)
      if (byId) {
        printTeam(byId)
        return
      }
      const byTicket = teams.filter(team => team.ticketId === ref || team.ticketId.startsWith(ref))
      if (byTicket.length === 0) {
        console.log(`no team matches ${ref}; use "pnpm ds-agent teams" to list all teams`)
        return
      }
      console.log(`ticket ${ref}: ${byTicket.length} team(s)`)
      for (const team of byTicket) printTeam(team)
    } finally {
      store.close()
    }
    return
  }
  if (cmd === 'teams') {
    const ticket = option('ticket')
    const session = option('session')
    const store = new Store(home)
    try {
      let teams = store.listDocs<TeamRecord>('team')
      if (ticket) teams = teams.filter(team => team.ticketId === ticket)
      if (session) teams = teams.filter(team => team.parentSessionId === session)
      if (teams.length === 0) console.log('no teams')
      for (const team of teams) console.log(teamLine(team))
    } finally {
      store.close()
    }
    return
  }
  if (cmd === 'pause') {
    const ticketRef = bare(3, ['reason'])[0]
    const reason = option('reason')
    withEngine((engine, store) => {
      const ticket = resolveTicket(store, ticketRef)
      const outcome = engine.pause(ticket.id, { reason })
      if (!outcome.changed) {
        console.log(`ticket ${ticket.id} is already paused.`)
      } else {
        console.log(`paused ${ticket.id} "${ticket.title}"${reason ? ` — ${reason}` : ''}`)
      }
      console.log(`  stage: ${ticketStage(outcome.ticket)}`)
      console.log(`  next:  pnpm ds-agent resume ${ticket.id}`)
    }, { verbose: process.argv.includes('--verbose') })
    return
  }
  if (cmd === 'intervene') {
    const rest = bare(3, ['text', 'reason'])
    const ticketRef = rest[0]
    const text = option('text') ?? rest.slice(1).join(' ')
    if (!text.trim()) throw new Error('intervene needs guidance text: ds-agent intervene <ticketId> "your note"')
    const noPause = process.argv.includes('--no-pause')
    withEngine((engine, store) => {
      const ticket = resolveTicket(store, ticketRef)
      const outcome = engine.intervene(ticket.id, text, {
        pause: !noPause,
        reason: option('reason'),
      })
      console.log(`guidance ${outcome.guidance.id} added to ${ticket.id}: "${outcome.guidance.text}"`)
      if (outcome.paused) {
        console.log(`  task is paused; resume with: pnpm ds-agent resume ${ticket.id}`)
      } else {
        console.log('  task is running; the next Router/Worker turn will include this guidance.')
      }
    }, { verbose: process.argv.includes('--verbose') })
    return
  }
  if (cmd === 'resume') {
    const ticketRef = bare(3, ['reason'])[0]
    const reason = option('reason')
    const resolved = (() => {
      const store = new Store(home)
      try {
        return resolveTicket(store, ticketRef)
      } finally {
        store.close()
      }
    })()
    await withRuntime(async runtime => {
      const outcome = await runtime.resume(resolved.id, { reason })
      if (!outcome.resumed) {
        console.log(`ticket ${resolved.id} is not paused; nothing to resume.`)
        console.log(`  stage: ${ticketStage(outcome.ticket)}`)
        return
      }
      console.log(`resumed ${resolved.id} "${resolved.title}"${reason ? ` — ${reason}` : ''}`)
      console.log(`  stage: ${ticketStage(outcome.ticket)}`)
      const pending = outcome.ticket.collab?.guidance.filter(item => !item.seenByWorker).length ?? 0
      if (pending > 0) console.log(`  guidance delivered in this turn: ${pending}`)
    }, requireLiveModelFromEnv())
    return
  }
  if (cmd === 'collab') {
    const ticketRef = bare(3)[0]
    withEngine((engine, store) => {
      const ticket = resolveTicket(store, ticketRef)
      const { collaboration } = engine.collaboration(ticket.id)
      console.log(`ticket ${ticket.id} [${ticketStage(ticket)}] ${ticket.title}`)
      const paused = collaboration.paused
      console.log(
        paused
          ? `paused: ${paused.at} by ${paused.by}${paused.reason ? ` — ${paused.reason}` : ''}`
          : 'paused: no',
      )
      if (collaboration.guidance.length === 0) {
        console.log('guidance: none')
      } else {
        console.log('guidance:')
        for (const item of collaboration.guidance) {
          const seen = [item.seenByWorker ? 'worker' : '', item.seenByRouter ? 'router' : '']
            .filter(Boolean)
            .join('+') || 'pending'
          console.log(`  ${item.id} [${seen}] ${item.text}`)
        }
      }
      if (collaboration.resumes.length > 0) {
        console.log('resumes:')
        for (const item of collaboration.resumes) {
          console.log(`  ${item.at} by ${item.by}${item.reason ? ` — ${item.reason}` : ''}`)
        }
      }
    })
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

function teamLine(team: TeamRecord): string {
  return `${team.id}\t${team.completedAt ? 'completed' : 'active'}\tticket=${team.ticketId}\tmembers=${team.members.length}`
}

function printTeam(team: TeamRecord): void {
  console.log(`team ${team.id} [${team.completedAt ? 'completed' : 'active'}]`)
  console.log(`  ticket:    ${team.ticketId}`)
  console.log(`  session:   ${team.parentSessionId}`)
  console.log(`  created:   ${team.createdAt}`)
  if (team.completedAt) console.log(`  completed: ${team.completedAt}`)
  console.log(`  topology:  ${describeTopologyOf(team)}`)
  for (const member of team.members) {
    const report = member.report ? ` — ${member.report}` : ''
    console.log(`  member ${member.name} (${member.role}) job=${member.jobId} status=${member.status}${report}`)
  }
  console.log('  aggregate:')
  for (const line of aggregateReportOf(team).split('\n')) console.log(`    ${line}`)
}

function uniqueTeam(teams: TeamRecord[], ref: string): TeamRecord | undefined {
  const exact = teams.find(team => team.id === ref)
  if (exact) return exact
  const matches = teams.filter(team => team.id.startsWith(ref))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) throw new Error(`ambiguous team ${ref}; matches: ${matches.map(team => team.id).join(', ')}`)
  return undefined
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

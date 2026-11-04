import { githubTrigger } from '../channels/github.ts'
import { cliTrigger } from '../channels/cli.ts'
import { imTrigger } from '../channels/im.ts'
import { Engine } from '../core/engine.ts'
import type { Host } from '../core/host.ts'
import { executionView, formatExecution } from '../core/panel.ts'
import { ticketStage } from '../core/stage.ts'
import { createModelFromEnv, requireLiveModelFromEnv, type Model } from '../harness/model.ts'
import { buildSystemPrompt, describePromptLayers, loadPromptFiles } from '../harness/prompts.ts'
import { LOCAL_AGENTS_FILE, loadLocalAgents } from '../env/local-agents.ts'
import { aggregateReportOf, describeTopologyOf, type TeamRecord } from '../harness/team.ts'
import { formatMetricsJson, Metrics } from '../metrics/metrics.ts'
import type { A2AEnvelope } from '../channels/a2a.ts'
import type { LongTermMemoryEntry } from '../memory/long-term.ts'
import { Runtime } from '../runtime.ts'
import { visibleTickets } from '../speculate/index.ts'
import type { JobRow, Role, SessionRow, Ticket } from '../shared/types.ts'
import { Store } from '../store/sqlite.ts'
import { healthProbe } from '../watchdog/health.ts'
import { startEmbeddedGateway } from '../gateway/embedded.ts'
import { defaultHome, runDemo } from './demo.ts'
import { runGatewayCommand } from './gateway.ts'
import { runImessageCommand } from './imessage.ts'
import { resolveServeChannelConfigs, runChannelsCheck, startServeChannels } from './channels.ts'
import { backupUsage, runBackupCli } from './backup.ts'
import { runUi } from './ui.ts'
import { runProfileCommand, runWireCommand } from './wiring.ts'
import { runSetupCommand } from './setup.ts'

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
  pnpm ds-agent panel            # Panel · Execution (tickets, mandate, executor, outbox)
  pnpm ds-agent retry <ticketId> # new Assignment on the same Ticket
  pnpm ds-agent status
  pnpm ds-agent health
  pnpm ds-agent serve [--imessage] [--feishu] [--handle <id>] [--chat <id>]
                            [--allow-any] [--allow-groups] [--interval <ms>]
                            [--since <epoch-ms>] [--once]
                            # daemon timer over persisted state; optional inbound iMessage
                            # and/or Feishu poll loop; the two loops share one Runtime but
                            # keep independent cursors, outboxes, and abort controllers
  pnpm ds-agent channels check [--imessage] [--feishu] [--network]
                            # offline preflight: no model, no SQLite, no message send;
                            # --network only calls Feishu tenant_access_token
  pnpm ds-agent chat "fix the login timeout"
  pnpm ds-agent gateway [--port 4319] [--host 127.0.0.1]  # local OpenAI-compatible model gateway
  pnpm ds-agent setup [--write] [--url http://host:port/v1]  # discover local LLMs, write gateway.config.json
  pnpm ds-agent ui [--host 127.0.0.1] [--port <n>] [--token <token>]
                            # read-only loopback dashboard over persisted state; requires
                            # DS_AGENT_UI_TOKEN or --token (at least 16 characters)
  pnpm ds-agent backup --out <file.db>  # WAL-safe snapshot of the SQLite store
  pnpm ds-agent restore <file.db> [--force]
                            # replace the store from a snapshot; --force is required
                            # when a store already exists (the old one is kept aside)
  pnpm ds-agent imessage [--handle <id>] [--allow-any] [--allow-groups] [--once] [--interval 2000]
                            # two-way iMessage channel; sender admission is default-deny
  pnpm ds-agent wire <file> --set KEY=VALUE [--env]  # merge gateway settings into an agent config
  pnpm ds-agent profile list|save <name>|use <name>|rm <name>  # gateway config profiles
  pnpm ds-agent emit im --thread bug-login --text "login still 500"
  pnpm ds-agent emit github --pr 42 --text "CI failed on auth test"
  pnpm ds-agent metrics
  pnpm ds-agent memory [--limit 10]   # persisted cross-ticket memories
  pnpm ds-agent a2a [--limit 10]      # persisted A2A envelopes
  pnpm ds-agent prompt [--role router|worker|watchdog] [--layers] [--json]
                            # the layered system prompt and where each layer comes from
  pnpm ds-agent agents [--json]  # local specialist agents configured for delegation

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
demo/retry/resume need a live model; chat may use MockModel.
pause/intervene/collab/team/teams are offline.

imessage refuses to start (default-deny) without --handle/DS_AGENT_IMESSAGE_HANDLE
or a non-empty DS_AGENT_ACTOR_ALLOWLIST. --allow-any is an explicit opt-out that
accepts any 1:1 sender; --allow-groups opens group ingestion, and group messages
are never marked direct.

serve starts the in-process watchdog/daemon timer over persisted SQLite state. By
default it has no inbound channel loop: triggers written by a separate emit/chat
process are not picked up. Pass --imessage to run the same inbound iMessage poll
loop as "ds-agent imessage" alongside the daemon; it uses that command's
default-deny sender admission, cursor, and outbox, and refuses to start before
chat.db is opened. --allow-groups opens group ingestion; group messages are never
marked direct. Pass --feishu to poll one Feishu chat: it requires
FEISHU_APP_ID/FEISHU_APP_SECRET and FEISHU_CHAT_ID or --chat <id>, validates them
before SQLite is opened, and stores its cursor in SQLite as
{ chatId, lastCreateTimeMs }. --since <epoch-ms> overrides the stored cursor for
one start; otherwise the stored cursor for that chat seeds the poll, otherwise
the source starts at now-5min. Feishu triggers keep the chat id in
channel.address.group, so DS_AGENT_GROUP_ALLOWLIST admits by chat; only a real
bot mention sets addressed=mention, and group messages are never marked direct.
--imessage and --feishu may be combined: both configurations are resolved before
Runtime.create, one Runtime/SQLite store is shared, and each loop keeps its own
AbortController, cursor, and outbox. If either configuration is absent or
invalid, serve fails before opening SQLite, chat.db, or the Feishu network and
names every missing item; it never starts with only one half configured. A loop
failure is logged and does not kill the other loop or the daemon. Feishu
inbound is polling only: one chat per process, with no webhook server or
long-connection listener. Poll errors are logged and retried with bounded
backoff, so they do not kill the loop or the daemon. A Full Disk Access denial
is terminal for the iMessage loop and includes the exact System Settings path;
serve keeps the daemon and any other channel running. The model is fixed at
Runtime.create, so mount credentials before starting and restart to change them.
With no provider key the idle daemon uses MockModel, and Gate-deferred
assessments stay queued for a live-model start.
The first SIGINT/SIGTERM aborts every inbound loop, waits for both drains, closes
the iMessage API, then drains through Runtime.finish() (assessments, jobs,
daemon timer, SQLite), and exits 0; a second signal force-exits 1 if it hangs.

Run "ds-agent channels check" before serve. It needs no model and opens no
SQLite. For iMessage it opens chat.db read-only, checks the required columns,
prints count/latest ROWID (never message text), reports admission and osascript
presence, and prints the exact manual Automation command without running it. For
Feishu it reports paired credentials, chat id, base URL, and scopes without
printing secrets; --network adds one real tenant_access_token call and still
sends no message. Exit 0 means every selected channel is ready. A safe no-send
smoke is: run channels check (optionally --network), run the printed iMessage
Automation command manually, then stop; the first real Router reply is the first
real send. TCC errors are reported with "Grant Full Disk Access to your
terminal" and System Settings > Privacy & Security > Full Disk Access; allow the
terminal to control Messages under System Settings > Privacy & Security >
Automation.

Feishu setup: create a custom app with the Bot capability, add scopes im:message,
im:message:send_as_bot, im:message:readonly, and im:message.group_msg (for group
history), publish an app version, add the bot to exactly one target chat, copy
its oc_... chat id, then set FEISHU_APP_ID, FEISHU_APP_SECRET, and
FEISHU_CHAT_ID (or pass --chat). Inbound CLI delivery is one-chat polling only;
webhook servers and long-connection/WebSocket delivery are not implemented.

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

/**
 * If a gateway.config.json exists and no DS_AGENT_GATEWAY_URL is set, start the
 * gateway in-process for the duration of `run`, so chat/imessage need no
 * separate gateway process.
 */
async function runWithEmbeddedGateway(home: string, run: () => Promise<void>): Promise<void> {
  const embedded = await startEmbeddedGateway(home)
  if (embedded) {
    process.env.DS_AGENT_GATEWAY_URL = embedded.url
    process.env.DS_AGENT_GATEWAY_TOKEN = embedded.token
  }
  try {
    await run()
  } finally {
    if (embedded) await embedded.close()
  }
}

/**
 * Daemon timer over persisted SQLite state: one Runtime for the process lifetime.
 *
 * Scope: starts the in-process watchdog/daemon timer and, when a live model is
 * configured, assesses Gate-deferred threads already in SQLite at startup. By
 * default no inbound channel loop, so triggers written by a separate
 * `emit`/`chat` process are never picked up. With `--imessage` it also runs the
 * same inbound iMessage poll loop as `ds-agent imessage`, sharing that command's
 * default-deny admission, cursor, and outbox. With `--feishu` it runs an
 * inbound Feishu poll loop over `FEISHU_CHAT_ID`/`--chat`, with a durable
 * `feishu_cursor` document. Both may run together: each config is validated
 * before Runtime.create, one Runtime/SQLite store is shared, and each loop has
 * its own abort controller, cursor, and outbox. The model is resolved once at
 * Runtime.create; changing credentials requires a restart. A keyless process
 * falls back to MockModel and leaves deferred assessments queued for a
 * live-model start. chat and serve may run on MockModel;
 * demo/retry/resume require a live model.
 *
 * Shutdown is signal-driven. The first SIGINT/SIGTERM aborts every inbound poll
 * loop, waits for both drains, closes the iMessage API, then runs
 * Runtime.finish(), which waits for Main Agent assessments and Harness jobs,
 * stops the Daemon timer, and closes SQLite before exiting 0. A second signal
 * force-exits 1 in case a live turn or finish() itself hangs. In-flight turns
 * are not reconstructed after a restart; that boundary is documented in
 * docs/MODULES.md.
 */
async function serve(home: string): Promise<void> {
  // Resolve and validate every opt-in inbound channel before Runtime.create
  // opens SQLite (and long before ChatDbImessageApi opens chat.db or a Feishu
  // client makes a network call). A missing allowlist or app credential must
  // leave every permissioned resource untouched.
  const configs = resolveServeChannelConfigs()

  const runtime = Runtime.create({
    home,
    jobDelayMs: 20,
    watchdogIntervalMs: 60_000,
  })
  const canAssess = runtime.model.name !== 'MockModel'
  // Independent loops: each channel owns its AbortController and Outbox, but
  // both run over this one Runtime and SQLite store.
  let channels: ReturnType<typeof startServeChannels> | undefined
  let stopping = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) {
      runtime.log.info(`[serve] second signal=${signal}; force exit`)
      process.exit(1)
    }
    stopping = true
    // Stop polling first so no new Trigger is ingested while finish() drains.
    channels?.abort()
    runtime.log.info(`[serve] shutdown signal=${signal}; draining (send again to force exit)`)
    void (async () => {
      // The loops own their outbox and cursor writes; let both finish before
      // the iMessage API closes and Runtime.finish() closes SQLite.
      if (channels) {
        await channels.wait()
        channels.close()
      }
      await runtime.finish()
    })()
      .then(() => {
        runtime.log.info('[serve] stopped')
        // Let the event loop drain so buffered stdout is flushed; the daemon
        // timer is stopped, so nothing keeps the process alive.
        process.exitCode = 0
      })
      .catch(error => {
        console.error(`[serve] shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
        // Runtime.finish() releases both on its own, but keep shutdown safe if
        // a future finish() path rejects before it reaches that block.
        channels?.close()
        runtime.daemon.stop()
        if (runtime.store.isOpen) {
          try {
            runtime.store.close()
          } catch {
            // The signal path is already failing; preserve the exit code.
          }
        }
        process.exitCode = 1
      })
  }
  // Install handlers before start() so a signal cannot race the ready line.
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  try {
    runtime.start({ assessPending: canAssess })
  } catch (error) {
    channels?.abort()
    channels?.close()
    await runtime.finish().catch(() => undefined)
    throw error
  }
  if (!canAssess) {
    runtime.log.info('[serve] MockModel: deferred assessments left queued until a live-model start')
  }
  if (configs.imessage && !stopping) {
    if (configs.imessage.allowAny) {
      runtime.log.info(
        '[imessage] WARNING: --allow-any is active; any sender in a 1:1 chat can trigger work. '
        + 'Prefer --handle or DS_AGENT_ACTOR_ALLOWLIST unless this is intentional.',
      )
    }
    if (configs.imessage.allowGroups) {
      runtime.log.info(
        '[imessage] WARNING: --allow-groups is active; group messages are ingested, '
        + 'but they are never marked direct and still pass normal admission.',
      )
    }
  }
  if (!stopping) {
    try {
      channels = startServeChannels({ runtime, ...configs })
    } catch (error) {
      channels?.abort()
      channels?.close()
      await runtime.finish().catch(() => undefined)
      throw error
    }
  }
  runtime.log.info(`ds-agent serve ready home=${home} pid=${process.pid} model=${runtime.model.name}`)
  // Keep the CLI promise pending; the daemon timer keeps the process alive and a
  // signal handler exits after the drain.
  await new Promise<void>(() => undefined)
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
  if (cmd === 'panel' || cmd === 'execution') {
    const store = new Store(home)
    try {
      console.log(formatExecution(executionView(store, home)))
    } finally {
      store.close()
    }
    return
  }
  if (cmd === 'retry') {
    const ticketRef = bare(3)[0]
    const resolved = (() => {
      const store = new Store(home)
      try {
        return resolveTicket(store, ticketRef)
      } finally {
        store.close()
      }
    })()
    await withRuntime(async runtime => {
      const ticket = await runtime.retry(resolved.id, option('reason') ?? 'manual retry')
      if (!ticket) {
        console.log(`unknown ticket ${resolved.id}`)
        return
      }
      console.log(`retry queued ${ticket.id} "${ticket.title}" (new Assignment, stage ${ticketStage(ticket)})`)
    }, requireLiveModelFromEnv())
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
  if (cmd === 'channels') {
    if (sub !== 'check') {
      throw new Error('channels needs "check": ds-agent channels check [--imessage] [--feishu] [--network]')
    }
    const report = await runChannelsCheck({
      network: process.argv.includes('--network'),
    })
    for (const line of report.lines) console.log(line)
    process.exitCode = report.code
    return
  }
  if (cmd === 'serve') {
    await serve(home)
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
            kind: entry.kind ?? 'note',
            tier: entry.tier ?? 'hot',
            refs: entry.refs?.map(ref => ref.id) ?? [],
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
    console.log(`tickets ${visibleTickets(store.listDocs<Ticket>('ticket')).length}`)
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
    await runWithEmbeddedGateway(home, () => withRuntime(runtime => { runtime.ingest(cliTrigger({ text })) }))
    return
  }
  if (cmd === 'imessage') {
    await runWithEmbeddedGateway(home, () => runImessageCommand(home))
    return
  }
  if (cmd === 'gateway') {
    await runGatewayCommand(home)
    return
  }
  if (cmd === 'setup') {
    await runSetupCommand(home)
    return
  }
  if (cmd === 'wire') {
    runWireCommand()
    return
  }
  if (cmd === 'profile') {
    runProfileCommand(home)
    return
  }
  if (cmd === 'ui') {
    // Token enforcement (>=16 chars, --token or DS_AGENT_UI_TOKEN) and the
    // loopback-only bind stay in runUi; this dispatch only forwards options.
    const rawPort = option('port')
    const port = rawPort === undefined ? undefined : Number(rawPort)
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
      throw new Error(`invalid ui port: ${rawPort}`)
    }
    await runUi(home, {
      host: option('host'),
      port,
      token: option('token'),
    })
    return
  }
  if (cmd === 'backup' || cmd === 'restore') {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
      console.log(backupUsage())
      return
    }
    if (cmd === 'backup') {
      const out = option('out')
      if (out === undefined) {
        console.error(backupUsage())
        process.exitCode = 1
        return
      }
      process.exitCode = runBackupCli(['--home', home, '--out', out])
      return
    }
    const backupPath = bare(3, ['home', 'input'])[0]
    if (backupPath === undefined) {
      console.error(backupUsage())
      process.exitCode = 1
      return
    }
    process.exitCode = runBackupCli([
      '--home', home,
      '--input', backupPath,
      ...(process.argv.includes('--force') ? ['--force'] : []),
    ])
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
  if (cmd === 'prompt') {
    const role = option('role') ?? 'router'
    if (role !== 'router' && role !== 'worker' && role !== 'watchdog') {
      throw new Error('role must be router, worker, or watchdog')
    }
    const agents = loadLocalAgents(home, process.env).map(agent => ({
      id: agent.id,
      ...(agent.description ? { description: agent.description } : {}),
    }))
    const input = {
      role: role as Role,
      ...loadPromptFiles(home, process.env),
      ...(agents.length ? { localAgents: agents } : {}),
    }
    const layers = describePromptLayers(input)
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(layers, null, 2))
      return
    }
    if (process.argv.includes('--layers')) {
      for (const layer of layers) {
        console.log(`${layer.id.padEnd(14)}${layer.text.length} chars  ${layer.source}`)
      }
      return
    }
    console.log(buildSystemPrompt(input))
    return
  }
  if (cmd === 'agents') {
    const agents = loadLocalAgents(home, process.env)
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(agents, null, 2))
      return
    }
    if (!agents.length) {
      console.log(`no local agents configured (${LOCAL_AGENTS_FILE} or DS_AGENT_LOCAL_AGENTS)`)
      return
    }
    for (const agent of agents) {
      const description = agent.description ? `  ${agent.description}` : ''
      console.log(`${agent.id.padEnd(14)}${agent.command}${description}`)
    }
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

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cliTrigger, githubTrigger, imTrigger, renderOutbound, truncateWords } from '../src/channels/index.ts'
import { LocalEnv } from '../src/env/local-env.ts'
import { FileVault } from '../src/env/vault.ts'
import { allowlistedEnv, redactSecrets, secretValues } from '../src/env/sanitize.ts'
import { Daemon } from '../src/harness/daemon.ts'
import { MachineRegistry } from '../src/harness/machines.ts'
import { MockModel, requireLiveModelFromEnv } from '../src/harness/model.ts'
import { PROVIDER_PRESETS, resolveLiveApi } from '../src/harness/providers.ts'
import { parseThreadKey } from '../src/ingress/thread.ts'
import { nextBatch } from '../src/ingress/batch.ts'
import { filterTrigger } from '../src/ingress/filter.ts'
import { grantTicketSpill, readSpillFor } from '../src/memory/acl.ts'
import { INLINE_LIMIT, inlineOrSpill } from '../src/memory/recall.ts'
import type { Runtime } from '../src/runtime.ts'
import { HeuristicDeliverGate, maySurface, visibleTickets } from '../src/speculate/index.ts'
import { spillPort, Store } from '../src/store/index.ts'
import type { Ticket } from '../src/shared/types.ts'
import { healthProbe } from '../src/watchdog/health.ts'
import { freshRuntime, settleWithDeadline, shutdown } from './fixtures.ts'

/**
 * One live end-to-end exercise per module.
 *
 * No Runtime here may use MockModel unless DS_AGENT_ALLOW_MOCK_FIXTURE=1
 * (offline CI only). Structural assertions stay soft where the live model
 * chooses its own path; each test also writes its log under
 * /tmp/ds-agent-live-e2e-logs/modules/ for inspection.
 */

const logDir = '/tmp/ds-agent-live-e2e-logs/modules'
fs.mkdirSync(logDir, { recursive: true })

const allowMock = process.env.DS_AGENT_ALLOW_MOCK_FIXTURE === '1'

function detectLive(): boolean {
  try {
    return resolveLiveApi() !== null
  } catch {
    return false
  }
}

const forceOffline = process.env.DS_AGENT_ALLOW_MOCK_FIXTURE === '1' || process.env.CI === 'true'
const hasLive = !forceOffline && detectLive()
const enabled = hasLive || allowMock

function writeLog(name: string, runtime: Runtime | undefined, extra: Record<string, unknown> = {}): void {
  const body = [
    `hasLive=${hasLive} allowMock=${allowMock}`,
    `model=${runtime?.model.name ?? 'n/a'}`,
    `home=${runtime?.home ?? 'n/a'}`,
    `extra=${JSON.stringify(extra)}`,
    '--- log ---',
    runtime?.log.text() ?? '',
  ].join('\n')
  fs.writeFileSync(path.join(logDir, name), body)
}

/** Guard for task 1: MockModel appears only under DS_AGENT_ALLOW_MOCK_FIXTURE=1. */
function expectLiveRuntime(runtime: Runtime): void {
  if (allowMock) expect(runtime.model.name).toBe('MockModel')
  else expect(runtime.model.name).toBe('HttpOpenAI')
}

let runtime: Runtime | undefined
const dirs: string[] = []

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!enabled)('live module E2E', () => {
  it('fixtures refuse MockModel unless DS_AGENT_ALLOW_MOCK_FIXTURE=1', () => {
    if (allowMock) {
      runtime = freshRuntime({ model: new MockModel(), jobDelayMs: 0 })
      expect(runtime.model.name).toBe('MockModel')
      return
    }
    expect(() => freshRuntime({ model: new MockModel() })).toThrow(/refuses MockModel/)
    expect(requireLiveModelFromEnv().name).toBe('HttpOpenAI')
  })

  it('Channel: IM/GitHub/CLI triggers carry source norms and render outbound per channel', async () => {
    runtime = freshRuntime({ watchdogIntervalMs: 60_000 })
    expectLiveRuntime(runtime)

    const im = imTrigger({
      id: 'mod_channel_im',
      thread: 'topic/mod-channel',
      text: '@ds-agent please check the login timeout and reply in one sentence',
      actor: 'alex',
    })
    const gh = githubTrigger({ id: 'mod_channel_gh', pr: 501, text: 'CI failed: login timeout on checkout' })
    const cli = cliTrigger({ id: 'mod_channel_cli', text: 'please check the login timeout' })

    expect(im.source).toBe('im')
    expect(im.channel).toEqual({ source: 'im', thread: 'topic/mod-channel' })
    expect(gh.source).toBe('github')
    expect(gh.channel).toEqual({ source: 'github', thread: 'pr/501' })
    expect(cli.source).toBe('cli')
    expect(cli.actor.id).toBe('you')

    expect(runtime.ingest(im)).toBe('stored')
    await settleWithDeadline(runtime, 30_000)

    const long = Array.from({ length: 140 }, (_, index) => `word${index}`).join(' ')
    const imOut = renderOutbound('im', long, 'ticket_norm')
    expect(truncateWords(long, 100)).toContain('…')
    expect(imOut.length).toBeLessThan(long.length)
    const ghOut = renderOutbound('github', 'fixed the timeout', 'ticket_norm')
    expect(ghOut).toContain('ds-agent note')
    expect(ghOut).toContain('ticket: ticket_norm')
    expect(renderOutbound('cli', 'plain reply', 'ticket_norm')).toBe('plain reply')

    const log = runtime.log.text()
    expect(log).toMatch(/\[ingress\]/)
    expect(log).toMatch(/\[engine\] Intake\.receive/)
    writeLog('01-channel.txt', runtime, { im, gh, cli, imOutWords: imOut.split(/\s+/).length })
  }, 180_000)

  it('Ingress: fast+semantic filter admits, drops noise, and dedupes by trigger id', async () => {
    runtime = freshRuntime({ watchdogIntervalMs: 60_000 })
    expectLiveRuntime(runtime)

    const model = runtime.model
    const noise = imTrigger({
      id: 'mod_ingress_noise',
      thread: 'topic/mod-ingress',
      text: 'lol nice weather today haha',
      addressed: false,
    })
    const verdict = filterTrigger(noise, model)
    expect(verdict.action).toBe('drop')
    expect(verdict.layer).toBe('fast')

    const good = imTrigger({
      id: 'mod_ingress_good',
      thread: 'topic/mod-ingress',
      text: '@ds-agent please investigate the login timeout',
      actor: 'alex',
    })
    expect(filterTrigger(good, model).action).toBe('pass')
    expect(parseThreadKey('im:topic/mod-ingress')).toEqual({ source: 'im', id: 'topic/mod-ingress' })
    expect(nextBatch(['a', 'b'])).toEqual(['a', 'b'])

    expect(runtime.ingest(noise)).toBe('filtered')
    expect(runtime.ingest(noise)).toBe('duplicate')
    expect(runtime.ingest(good)).toBe('stored')
    await settleWithDeadline(runtime, 30_000)

    const log = runtime.log.text()
    expect(log).toContain('action=drop')
    expect(log).toContain('action=pass')
    expect(log).toContain('result=duplicate')
    expect(runtime.metrics.snapshot().counters['ingress.admit']).toBeGreaterThanOrEqual(1)
    expect(runtime.metrics.snapshot().counters['ingress.drop']).toBeGreaterThanOrEqual(1)
    writeLog('02-ingress.txt', runtime, { verdict, metrics: runtime.metrics.snapshot().counters })
  }, 180_000)

  it('Engine: receive, evaluateDue, decide, and reports keep synchronous domain invariants', async () => {
    runtime = freshRuntime({ watchdogIntervalMs: 60_000 })
    expectLiveRuntime(runtime)

    const first = imTrigger({
      id: 'mod_engine_1',
      thread: 'topic/mod-engine',
      text: '@ds-agent please fix the login timeout on checkout',
      actor: 'alex',
    })
    expect(runtime.engine.receive(first)).toBe('stored')
    const accepted = runtime.engine.evaluateDue().find(decision => decision.kind === 'accept')
    expect(accepted?.ticketId).toBeTruthy()
    const ticket = runtime.store.getDoc<Ticket>('ticket', accepted!.ticketId!)!
    expect(ticket.mandate.strength).toBe('explicit')
    expect(ticket.assignments[0]?.state).toBe('pending')

    const second = imTrigger({
      id: 'mod_engine_2',
      thread: 'topic/mod-engine-2',
      text: '@ds-agent please investigate the payment timeout',
      actor: 'alex',
    })
    expect(runtime.engine.receive(second)).toBe('stored')
    const decided = runtime.engine.decide(second.id, { kind: 'accept', reason: 'module e2e' })
    expect(decided.kind).toBe('accept')
    expect(decided.ticketId).toBeTruthy()

    const events = runtime.store.listEvents().map(event => event.type)
    expect(events).toContain('trigger.received')
    expect(events).toContain('ticket.created')
    expect(events).toContain('decision.recorded')
    writeLog('03-engine.txt', runtime, { ticketId: ticket.id, decided })
  }, 120_000)

  it('Store: documents, spills, jobs, sessions, replies, events survive reopen', () => {
    runtime = freshRuntime({ watchdogIntervalMs: 60_000 })
    expectLiveRuntime(runtime)
    const store = runtime.store
    const home = runtime.home

    store.putDoc('module', 'doc_1', { hello: 'live' })
    expect(store.getDoc('module', 'doc_1')).toEqual({ hello: 'live' })
    expect(store.listDocs('module')).toHaveLength(1)

    const spillId = store.putSpill('long body for the store module')
    expect(store.getSpill(spillId)).toBe('long body for the store module')
    const port = spillPort(store)
    expect(port.get(port.put('via-por'))).toBe('via-por')

    const job = store.createJob({ sessionId: 'worker_mod', ticketId: 'ticket_mod', name: 'probe' })
    expect(store.getJob(job.id)?.status).toBe('running')
    store.completeJob(job.id, 'succeeded')
    expect(store.getJob(job.id)?.status).toBe('succeeded')

    store.upsertSession({
      id: 'worker_mod',
      role: 'worker',
      ticketId: 'ticket_mod',
      status: 'idle',
      heartbeat: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    })
    expect(store.listSessions().some(row => row.id === 'worker_mod')).toBe(true)
    store.appendMessage('worker_mod', 'assistant', 'probe message')
    expect(store.listMessages('worker_mod').some(row => row.body === 'probe message')).toBe(true)

    store.addReply({
      id: 'reply_mod',
      ticketId: 'ticket_mod',
      channel: 'im',
      purpose: 'result',
      text: 'probe',
      status: 'pending',
      createdAt: new Date().toISOString(),
    })
    store.markReplySent('reply_mod')
    expect(store.listReplies().find(row => row.id === 'reply_mod')?.status).toBe('sent')
    store.addEvent('ticket.created', { ticketId: 'ticket_mod' })
    expect(store.listEvents().some(event => event.type === 'ticket.created')).toBe(true)

    store.close()
    const reopened = new Store(home)
    expect(reopened.health()).toBe('ok')
    expect(reopened.getDoc('module', 'doc_1')).toEqual({ hello: 'live' })
    expect(reopened.getSpill(spillId)).toBe('long body for the store module')
    expect(reopened.getJob(job.id)?.status).toBe('succeeded')
    reopened.close()
    writeLog('04-store.txt', runtime, { spillId, jobId: job.id })
  }, 120_000)

  it('Env: allowlisted shell, secret redaction, vault injection, and isolated promote/discard', async () => {
    runtime = freshRuntime({ watchdogIntervalMs: 60_000 })
    expectLiveRuntime(runtime)

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-env-module-'))
    dirs.push(root)
    const secret = 'sk-module-env-secret-123456'
    const vaultPath = path.join(root, 'vault.json')
    const vault = new FileVault(vaultPath)
    vault.set('MODULE_VAULT_TOKEN', 'vault-value-abcdef')
    expect(fs.statSync(vaultPath).mode & 0o077).toBe(0)

    const env = new LocalEnv(path.join(root, 'workspaces'), {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DS_AGENT_API_KEY: secret,
        FOO_LEAK: 'should-not-pass',
      },
      allowlist: ['PATH', 'HOME', 'DS_AGENT_API_KEY'],
      vault,
      vaultNames: ['MODULE_VAULT_TOKEN'],
    })
    expect(allowlistedEnv({ PATH: '/bin', DS_AGENT_API_KEY: secret, FOO_LEAK: 'x' })).toEqual({ PATH: '/bin' })
    expect(secretValues({ DS_AGENT_API_KEY: secret })).toEqual([secret])
    expect(redactSecrets(`key=${secret}`, [secret])).toBe('key=[redacted]')

    const printed = await env.bash('mod_env', 'echo "PATH=$PATH" "KEY=$DS_AGENT_API_KEY" "LEAK=$FOO_LEAK" "VAULT=$MODULE_VAULT_TOKEN"')
    expect(printed.code).toBe(0)
    expect(printed.stdout).toContain('PATH=')
    expect(printed.stdout).not.toContain(secret)
    expect(printed.stdout).not.toContain('should-not-pass')
    expect(printed.stdout).not.toContain('vault-value-abcdef')

    await env.writeFile('mod_env', 'note.txt', 'live workspace note')
    expect(await env.readFile('mod_env', 'note.txt')).toBe('live workspace note')

    await env.writeFile('mod_env', 'scratch.txt', 'speculative', { isolated: true })
    expect(fs.existsSync(path.join(root, 'workspaces', 'speculative', 'mod_env', 'scratch.txt'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'workspaces', 'mod_env', 'scratch.txt'))).toBe(false)
    env.promoteIsolated('mod_env')
    expect(fs.existsSync(path.join(root, 'workspaces', 'mod_env', 'scratch.txt'))).toBe(true)

    await env.writeFile('mod_env', 'again.txt', 'discard me', { isolated: true })
    env.discardIsolated('mod_env')
    expect(fs.existsSync(path.join(root, 'workspaces', 'speculative', 'mod_env'))).toBe(false)
    writeLog('05-env.txt', runtime, { vaultMode: 'ok', bashCode: printed.code })
  }, 120_000)

  it('Harness: a live router+worker turn leaves sessions, messages, and journal traces', async () => {
    runtime = freshRuntime({ watchdogIntervalMs: 60_000, jobDelayMs: 50 })
    expectLiveRuntime(runtime)

    expect(runtime.ingest(imTrigger({
      id: 'mod_harness',
      thread: 'topic/mod-harness',
      text: '@ds-agent please acknowledge the checkout login timeout in one short sentence',
      actor: 'alex',
    }))).toBe('stored')
    await settleWithDeadline(runtime, 60_000)

    const log = runtime.log.text()
    expect(log).toContain('RouterSession start')
    expect(log).toContain('WorkerSession start')
    const sessions = runtime.store.listSessions()
    expect(sessions.some(row => row.role === 'router')).toBe(true)
    expect(sessions.some(row => row.role === 'worker')).toBe(true)
    expect(runtime.store.listMessages().length).toBeGreaterThan(0)
    expect(runtime.store.listDocs<Ticket>('ticket').length).toBeGreaterThanOrEqual(1)
    const journal = path.join(runtime.home, 'sessions')
    expect(fs.existsSync(journal)).toBe(true)
    expect(fs.readdirSync(journal).some(name => name.endsWith('.jsonl'))).toBe(true)
    writeLog('06-harness.txt', runtime, {
      sessions: sessions.map(row => `${row.id}:${row.role}:${row.status}`),
      messages: runtime.store.listMessages().length,
    })
  }, 240_000)

  it('Memory: short bodies inline; long bodies spill, page only with a grant', async () => {
    runtime = freshRuntime({ watchdogIntervalMs: 60_000 })
    expectLiveRuntime(runtime)
    const store = runtime.store

    const shortBody = 'short note that stays inline'
    const short = inlineOrSpill(shortBody, body => store.putSpill(body))
    expect(short.spillId).toBeUndefined()
    expect(short.inline).toBe(shortBody)

    const longBody = `CI failed on auth: expected 200 got 500. ${'frame at auth/session.ts '.repeat(12)}`
    expect(longBody.length).toBeGreaterThan(INLINE_LIMIT)
    const long = inlineOrSpill(longBody, body => store.putSpill(body))
    expect(long.spillId).toBeTruthy()
    expect(long.inline).toContain(`spillId=${long.spillId}`)
    expect(store.getSpill(long.spillId!)).toBe(longBody)

    grantTicketSpill(store, long.spillId, 'ticket_mod_memory')
    const page = readSpillFor(store, long.spillId!, { ticketId: 'ticket_mod_memory' })
    expect(page.text.length).toBeLessThanOrEqual(200)
    expect(page.truncated).toBe(true)
    expect(() => readSpillFor(store, long.spillId!, { ticketId: 'ticket_other' })).toThrow(/not visible/)

    // The live runtime path also spills a long GitHub body before the worker runs.
    const liveBody = `CI failed on auth test. ${'frame at auth/session.ts '.repeat(12)}`
    expect(runtime.ingest(githubTrigger({ id: 'mod_memory_gh', pr: 502, text: liveBody }))).toBe('stored')
    await settleWithDeadline(runtime, 30_000)
    const loggedId = /spillId=(spill_\d+)/.exec(runtime.log.text())?.[1]
    expect(loggedId).toBeTruthy()
    expect(store.getSpill(loggedId!)).toBe(liveBody)
    writeLog('07-memory-spill-inline.txt', runtime, {
      inlineSpillId: long.spillId,
      liveSpillId: loggedId,
      pageLength: page.text.length,
    })
  }, 180_000)

  it('Speculate: gate holds replies and delivers only on an explicit/valuable ready report', async () => {
    runtime = freshRuntime({ watchdogIntervalMs: 60_000 })
    expectLiveRuntime(runtime)

    const gate = new HeuristicDeliverGate()
    expect(maySurface(true, undefined)).toBe(false)
    expect(maySurface(true, true)).toBe(true)
    expect(maySurface(false, undefined)).toBe(true)
    expect(gate.evaluate({
      ticket: { speculative: true } as Ticket,
      report: { kind: 'ready', text: 'could not reproduce', deliver: false },
    })).toBe('discard')

    expect(runtime.engine.receive(githubTrigger({
      id: 'mod_speculate',
      pr: 503,
      text: 'might be a flaky payment test, not sure it is ours',
      speculate: true,
    }))).toBe('stored')
    const decision = runtime.engine.evaluateDue().find(item => item.kind === 'accept')
    expect(decision?.ticketId).toBeTruthy()
    const ticketId = decision!.ticketId!
    const ticket = runtime.store.getDoc<Ticket>('ticket', ticketId)!
    expect(ticket.speculative).toBe(true)
    expect(visibleTickets([ticket])).toHaveLength(0)

    runtime.engine.reply(ticketId, 'must stay silent', 'result')
    expect(runtime.store.listReplies()).toHaveLength(0)
    expect(runtime.log.text()).toContain('reply held')

    const held = runtime.engine.report(ticketId, { kind: 'progress', text: 'investigating quietly', deliver: false })
    expect(held).toEqual({ surfaced: false, verdict: 'hold' })
    const delivered = runtime.engine.report(ticketId, {
      kind: 'ready',
      text: 'ready: reproduced the flake in payment retry',
      deliver: true,
    })
    expect(delivered.surfaced).toBe(true)
    expect(runtime.store.getDoc<Ticket>('ticket', ticketId)?.speculative).toBe(false)
    expect(runtime.metrics.snapshot().counters['speculate.deliver']).toBeGreaterThanOrEqual(1)
    writeLog('08-speculate.txt', runtime, { ticketId, held, delivered })
  }, 120_000)

  it('Watchdog: a stale assignment is nudged, then failed on the next tick', () => {
    runtime = freshRuntime({ stuckMs: 1_000, watchdogIntervalMs: 60_000 })
    expectLiveRuntime(runtime)
    const startedAt = '2020-01-01T00:00:00.000Z'

    runtime.store.putDoc('ticket', 'ticket_mod_watchdog', {
      id: 'ticket_mod_watchdog',
      title: 'stuck module e2e',
      brief: 'stuck module e2e',
      mandate: {
        strength: 'explicit',
        policyVersion: 'policy-v1',
        scope: 'stuck module e2e',
        actor: { source: 'im', id: 'alex' },
        basis: 'addressed',
      },
      threadKeys: ['im:topic/mod-watchdog'],
      channels: [],
      inputs: [],
      assignments: [{
        id: 'asg_mod_watchdog',
        state: 'running',
        speculative: false,
        startedAt,
        workerSessionId: 'worker_ticket_mod_watchdog',
      }],
      speculative: false,
      originTriggerId: 'mod_watchdog',
      createdAt: startedAt,
    })

    runtime.watchdog.tick()
    expect(runtime.log.text()).toContain('[watchdog] nudge')
    runtime.watchdog.tick()
    expect(runtime.log.text()).toContain('[watchdog] fail')
    expect(runtime.store.getDoc<Ticket>('ticket', 'ticket_mod_watchdog')?.ended).toBeTruthy()
    const health = healthProbe(runtime.store, runtime.home)
    expect(health.store).toBe('ok')
    expect(health.vaultMode).toBe('absent')
    writeLog('09-watchdog.txt', runtime, { health, counts: runtime.metrics.snapshot().counters })
  }, 120_000)

  it('BYOM/daemon: provider presets resolve, the live endpoint answers, and the daemon pulses', async () => {
    runtime = freshRuntime({ watchdogIntervalMs: 60_000 })
    expectLiveRuntime(runtime)

    const custom = resolveLiveApi({
      DS_AGENT_API_BASE: 'http://127.0.0.1:3425/v1',
      DS_AGENT_API_KEY: 'magpie',
      DS_AGENT_API_MODEL: 'workbuddy/deepseek-v4.1-flash',
    })
    expect(custom).toMatchObject({ provider: 'custom', model: 'workbuddy/deepseek-v4.1-flash' })
    expect(resolveLiveApi({ DS_AGENT_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k' })).toMatchObject({
      provider: 'deepseek',
      base: PROVIDER_PRESETS.find(preset => preset.id === 'deepseek')!.base,
    })
    expect(() => resolveLiveApi({ DS_AGENT_API_BASE: 'http://example.invalid/v1' })).toThrow(/refusing MockModel/)

    let liveModel = allowMock ? 'MockModel' : 'unresolved'
    if (hasLive) {
      const live = requireLiveModelFromEnv()
      liveModel = live.name
      expect(live.name).toBe('HttpOpenAI')
      try {
        const reply = await live.complete({
          role: 'router',
          messages: [{ role: 'user', content: 'Reply with exactly the word PONG and nothing else.' }],
          tools: [],
        })
        expect((reply.text ?? '').length).toBeGreaterThan(0)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Magpie can 403 under concurrent load; presets/daemon still validated above.
        if (!/HttpOpenAI 403|Request not allowed/.test(message)) throw error
        console.warn('[live-modules] BYOM live.complete skipped:', message.slice(0, 120))
      }
    } else {
      expect(() => requireLiveModelFromEnv({})).toThrow(/refusing MockModel/)
    }

    const machines = new MachineRegistry()
    machines.register('mod-hands', ['bash', 'fs'])
    const lines: string[] = []
    const daemon = new Daemon({ tick: () => runtime!.watchdog.tick(), intervalMs: 60_000 }, line => lines.push(line), machines)
    daemon.start()
    daemon.tick()
    daemon.onMachineResume('mod-hands')
    daemon.stop()
    expect(lines).toContain('[daemon] start')
    expect(lines.some(line => line.includes('resume'))).toBe(true)
    expect(lines).toContain('[daemon] stop')
    expect(runtime.watchdog.intervalMs).toBe(60_000)
    writeLog('10-byom-daemon.txt', runtime, { custom, liveModel, daemonLines: lines })
  }, 120_000)
})

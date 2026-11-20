import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { bindRolePorts } from '../src/core/role-ports.ts'
import { LocalEnv } from '../src/env/local-env.ts'
import { ToolRegistry } from '../src/harness/tools.ts'
import type { Runtime } from '../src/runtime.ts'
import { threadKey, type Decision, type Disposition, type Thread, type Ticket, type Trigger } from '../src/shared/types.ts'
import { freshRuntime, shutdown } from './fixtures.ts'
import { field, lastPrompt, ScriptedModel, silentModel } from './scripted-model.ts'
import { normalizeConnectorConfig } from '../src/connectors/config.ts'
import { connectorTrigger, ConnectorWakeScheduler, loadConnectorWakeState } from '../src/connectors/wake.ts'
import type { ConnectorDraft } from '../src/connectors/types.ts'
import type { GoogleWorkspaceApi } from '../src/connectors/google.ts'
import { normalizeProactiveConfig } from '../src/harness/proactive.ts'

const runtimes: Runtime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await shutdown(runtime)
})

function isolatedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  delete env.DS_AGENT_ALLOW_MOCK_FIXTURE
  delete env.DS_AGENT_ROUTER_MODEL
  delete env.DS_AGENT_WORKER_MODEL
  delete env.DS_AGENT_WATCHDOG_MODEL
  return env
}

function start(opts: { model?: ScriptedModel; env?: NodeJS.ProcessEnv; singleSession?: boolean } = {}): Runtime {
  const runtime = freshRuntime({
    model: opts.model ?? silentModel(),
    env: opts.env ?? isolatedEnv(),
    singleSession: opts.singleSession,
    jobDelayMs: 5,
    watchdogIntervalMs: 60_000,
  })
  runtimes.push(runtime)
  return runtime
}

/** Create a ticket with an explicit shard list, without starting the Harness. */
function shardedTicket(
  runtime: Runtime,
  id: string,
  shards: string[],
  thread = 'topic/guard',
): { triggerId: string; ticketId: string } {
  runtime.engine.receive(imTrigger({
    id,
    thread,
    text: '@ds-agent please fix the login timeout on checkout',
  }), { shards })
  const decision = runtime.engine.evaluateDue()[0]
  if (!decision?.ticketId) throw new Error('expected a ticket')
  return { triggerId: id, ticketId: decision.ticketId }
}

function toolRegistry(runtime: Runtime): ToolRegistry {
  return new ToolRegistry({
    store: runtime.store,
    ports: bindRolePorts(runtime.engine),
    env: new LocalEnv(`${runtime.home}/workspaces`),
    metrics: runtime.metrics,
    redact: text => text,
    log: () => undefined,
    scheduleJob: () => undefined,
    routerTurn: async () => undefined,
  })
}

/** Reports one ready result, which ends a non-speculative ticket. */
function reportingModel(prompts: string[] = []): ScriptedModel {
  return new ScriptedModel(request => {
    if (request.role === 'router') return { text: 'router-ok' }
    const prompt = lastPrompt(request)
    if (request.role === 'worker') prompts.push(prompt)
    const reported = request.messages.some(message => message.role === 'tool' && message.name === 'report_to_router')
    if (!reported) {
      return {
        toolCalls: [{
          id: 'report_1',
          name: 'report_to_router',
          args: {
            ticketId: field(prompt, 'ticketId'),
            text: 'ready: login timeout fixed by refreshing the token',
            deliver: true,
            kind: 'ready',
          },
        }],
      }
    }
    return { text: 'worker-done' }
  })
}

describe('Runtime service integration', () => {
  it('resumes a trigger-only interrupted ingress and leaves completed retries duplicate', () => {
    const runtime = start()
    const trigger = imTrigger({ id: 'trg_interrupted_ingress', thread: 'recovery/topic', text: 'synthetic event' })

    expect(runtime.ingest(trigger)).toBe('stored')
    expect(runtime.store.getDoc<Disposition>('disposition', trigger.id)).toBeDefined()
    const ticket = runtime.store.listDocs<Ticket>('ticket').find(row => row.originTriggerId === trigger.id)
    expect(ticket).toBeDefined()
    const originalInputs = ticket!.inputs.filter(input => input.triggerId === trigger.id).length
    runtime.store.deleteDoc('disposition', trigger.id)
    expect(runtime.ingest(trigger)).toBe('stored')
    const resumed = runtime.store.getDoc<Ticket>('ticket', ticket!.id)
    expect(resumed?.inputs.filter(input => input.triggerId === trigger.id)).toHaveLength(originalInputs)
    expect(runtime.ingest(trigger)).toBe('duplicate')
    expect(runtime.store.listDocs<Trigger>('trigger').filter(row => row.id === trigger.id)).toHaveLength(1)
  })

  it('isolates Runtime-diagnosed incomplete intake while later connector ingress uses Runtime', async () => {
    const runtime = start()
    const at = Date.now()
    const owner = imTrigger({
      id: 'connector-runtime-owner',
      thread: 'connector-runtime-owner',
      text: '@ds-agent please keep this thread available',
      at: new Date(at).toISOString(),
    })
    expect(runtime.ingest(owner)).toBe('stored')

    const oldDraft: ConnectorDraft = {
      service: 'gmail', kind: 'message', externalId: 'ambiguous-old', title: 'Old notice', text: 'old',
      occurredAt: new Date(at - 5 * 60_000).toISOString(), updatedAt: new Date(at - 5 * 60_000).toISOString(),
      wake: true, wakeReason: 'unread important mail',
    }
    const oldRecord = runtime.connectorIndex.upsert([oldDraft]).records[0]!
    const oldTrigger = connectorTrigger(oldRecord, {
      channel: { source: 'im', thread: owner.channel!.thread }, actor: owner.actor,
    }, at)
    runtime.store.putDoc('trigger', oldTrigger.id, oldTrigger)
    expect(runtime.ingest(oldTrigger)).toBe('incomplete')
    const oldPending = { at, trigger: oldTrigger, recordId: oldRecord.id, service: 'gmail' as const }
    runtime.store.putDoc('connector_wake', 'state', {
      lastCheckAt: at - 16 * 60_000,
      cursors: { gmail: new Date(at - 16 * 60_000).toISOString() },
      pending: [oldPending], wakes: [], notified: [],
    })

    const later: ConnectorDraft = {
      ...oldDraft, externalId: 'later-useful', title: 'Later notice', text: 'new event',
      occurredAt: new Date(at - 60_000).toISOString(), updatedAt: new Date(at).toISOString(),
    }
    const api: GoogleWorkspaceApi = {
      async fetch() { return [later] },
      async fetchPage() { return { drafts: [later] } },
    }
    const runner = new ConnectorWakeScheduler({
      now: () => at,
      store: runtime.store,
      index: runtime.connectorIndex,
      config: normalizeConnectorConfig({
        enabled: true,
        google: { services: ['gmail'] },
        poll: { intervalMinutes: 15 },
        wake: { enabled: true, services: ['gmail'], source: 'im', thread: owner.channel!.thread, minIntervalMinutes: 15, maxPerDay: 3 },
      }),
      api,
      proactive: normalizeProactiveConfig({ quietStart: '23:00', quietEnd: '08:00', timezone: 'UTC' }),
      fire: trigger => { runtime.ingest(trigger) },
    })

    await runner.poll(at)
    const state = loadConnectorWakeState(runtime.store)
    const laterRecord = runtime.connectorIndex.query({ limit: 20 }).find(row => row.externalId === 'later-useful')
    expect(laterRecord).toBeDefined()
    expect(state.incomplete).toMatchObject([{ pending: { trigger: { id: oldTrigger.id } } }])
    expect(state.wakes.some(row => row.triggerId === oldTrigger.id)).toBe(false)
    expect(laterRecord && runtime.store.getDoc<Disposition>('disposition', connectorTrigger(laterRecord, {
      channel: { source: 'im', thread: owner.channel!.thread }, actor: owner.actor,
    }, at).id)).toBeDefined()
  })

  it('does not reroute a partially fanned-out trigger after tickets or subscriptions change', () => {
    for (const scenario of [
      { name: 'ended original', endOriginal: true, keepOriginalSubscription: true },
      { name: 'changed subscription', endOriginal: false, keepOriginalSubscription: false },
    ]) {
      const runtime = start()
      const threadId = `recovery/${scenario.name.replaceAll(' ', '-')}`
      const seed = imTrigger({
        id: `trg_seed_${threadId}`,
        thread: threadId,
        text: '@ds-agent please fix the login timeout',
      })
      runtime.engine.receive(seed)
      const decision = runtime.engine.evaluateDue()[0]
      expect(decision?.ticketId).toBeDefined()
      const original = runtime.store.getDoc<Ticket>('ticket', decision!.ticketId!)!
      const follow = imTrigger({
        id: `trg_partial_${threadId}`,
        thread: threadId,
        text: 'the timeout still affects another request',
        actor: 'alex',
      })
      const secondaryRef = { source: 'im', id: `${threadId}/secondary` }
      follow.threads = [...follow.threads, secondaryRef]
      original.inputs.push({
        id: `input_partial_${threadId}`,
        kind: 'trigger',
        triggerId: follow.id,
        text: follow.text,
        at: follow.at,
        human: true,
      })
      if (scenario.endOriginal) {
        original.ended = { at: new Date().toISOString(), outcome: 'ready', by: 'router' }
      }
      runtime.store.putDoc('ticket', original.id, original)

      const { ended: _ended, ...originalBase } = original
      const replacement: Ticket = {
        ...originalBase,
        id: `ticket_replacement_${threadId}`,
        title: 'Replacement subscriber',
        originTriggerId: `trg_replacement_${threadId}`,
        createdAt: new Date().toISOString(),
        inputs: [],
      }
      runtime.store.putDoc('ticket', replacement.id, replacement)
      const key = threadKey(follow.threads[0]!)
      const secondaryKey = threadKey(secondaryRef)
      const laterAt = new Date(Date.parse(follow.at) + 60_000).toISOString()
      runtime.store.putDoc('thread', secondaryKey, {
        key: secondaryKey,
        ref: secondaryRef,
        createdAt: follow.at,
        lastAt: laterAt,
        subscriptions: [],
        correlated: ['im:preexisting-correlation'],
        pending: [],
        meta: {},
      } satisfies Thread)
      const thread = runtime.store.getDoc<Thread>('thread', key)!
      thread.subscriptions = scenario.keepOriginalSubscription
        ? [original.id, replacement.id]
        : [replacement.id]
      runtime.store.putDoc('thread', key, thread)
      runtime.store.putDoc('trigger', follow.id, follow)

      expect(runtime.ingest(follow)).toBe('incomplete')
      const resumedOriginal = runtime.store.getDoc<Ticket>('ticket', original.id)!
      const resumedReplacement = runtime.store.getDoc<Ticket>('ticket', replacement.id)!
      expect(resumedOriginal.inputs.filter(input => input.triggerId === follow.id)).toHaveLength(1)
      expect(resumedReplacement.inputs.filter(input => input.triggerId === follow.id)).toHaveLength(0)
      expect(runtime.store.getDoc<Disposition>('disposition', follow.id)).toBeUndefined()
      expect(runtime.store.getDoc('intake_recovery', follow.id)).toMatchObject({ triggerId: follow.id })
      expect(runtime.store.getDoc<Thread>('thread', key)?.pending).not.toContain(follow.id)
      const repairedPrimary = runtime.store.getDoc<Thread>('thread', key)!
      const repairedSecondary = runtime.store.getDoc<Thread>('thread', secondaryKey)!
      expect(repairedPrimary.lastAt).toBe(follow.at)
      expect(repairedPrimary.correlated).toContain(secondaryKey)
      expect(repairedSecondary.lastAt).toBe(laterAt)
      expect(repairedSecondary.correlated).toEqual(['im:preexisting-correlation', key])
      expect(runtime.ingest(follow)).toBe('incomplete')
    }
  })

  it('keeps ambiguous legacy A/B partial fanout incomplete without rerouting', () => {
    const runtime = start()
    const threadId = 'recovery/legacy-partial-a-b'
    const seed = imTrigger({ id: 'trg_legacy_ab_seed', thread: threadId, text: '@ds-agent fix this timeout' })
    runtime.engine.receive(seed)
    const evaluated = runtime.engine.evaluateDue()[0]!
    const ticketA = runtime.store.getDoc<Ticket>('ticket', evaluated.ticketId!)!
    const ticketB: Ticket = { ...ticketA, id: 'ticket_legacy_B', inputs: [], channels: [...ticketA.channels] }
    runtime.store.putDoc('ticket', ticketB.id, ticketB)
    const key = threadKey(seed.threads[0]!)
    const thread = runtime.store.getDoc<Thread>('thread', key)!
    thread.subscriptions = [ticketA.id, ticketB.id]
    runtime.store.putDoc('thread', key, thread)
    const follow = imTrigger({ id: 'trg_legacy_ab_follow', thread: threadId, text: 'still failing' })
    ticketA.inputs.push({
      id: 'input_legacy_ab_A', kind: 'trigger', triggerId: follow.id,
      text: follow.text, at: follow.at, human: true,
    })
    runtime.store.putDoc('ticket', ticketA.id, ticketA)
    runtime.store.putDoc('trigger', follow.id, follow)

    expect(runtime.ingest(follow)).toBe('incomplete')
    expect(runtime.store.getDoc<Ticket>('ticket', ticketB.id)?.inputs).toHaveLength(0)
    expect(runtime.store.getDoc<Disposition>('disposition', follow.id)).toBeUndefined()
    expect(runtime.store.getDoc('intake_recovery', follow.id)).toBeDefined()
  })

  it('restores pending Eval for legacy partial bot and context-only routing', () => {
    for (const scenario of [
      { name: 'bot', human: false, contextOnly: false },
      { name: 'context-only', human: true, contextOnly: true },
    ]) {
      const runtime = start()
      const threadId = `recovery/${scenario.name}-eval`
      const seed = imTrigger({
        id: `trg_${scenario.name}_eval_seed`,
        thread: threadId,
        text: '@ds-agent please fix the timeout issue',
      })
      runtime.engine.receive(seed)
      const decision = runtime.engine.evaluateDue()[0]
      const ticket = runtime.store.getDoc<Ticket>('ticket', decision!.ticketId!)!
      const follow = {
        ...imTrigger({
          id: `trg_${scenario.name}_eval_partial`,
          thread: threadId,
          text: 'background CI timeout details need review',
        }),
        human: scenario.human,
      }
      const key = threadKey(follow.threads[0]!)
      if (scenario.contextOnly) runtime.engine.followForContext(ticket.id, key)
      ticket.inputs.push({
        id: `input_${scenario.name}_eval_partial`,
        kind: 'context',
        triggerId: follow.id,
        text: follow.text,
        at: follow.at,
        human: follow.human,
      })
      runtime.store.putDoc('ticket', ticket.id, ticket)
      runtime.store.putDoc('trigger', follow.id, follow)
      const thread = runtime.store.getDoc<Thread>('thread', key)!
      thread.pending = thread.pending.filter(triggerId => triggerId !== follow.id)
      runtime.store.putDoc('thread', key, thread)

      expect(runtime.ingest(follow)).toBe('incomplete')
      expect(runtime.store.getDoc<Disposition>('disposition', follow.id)).toBeUndefined()
      expect(runtime.store.getDoc('intake_recovery', follow.id)).toBeDefined()
      expect(runtime.store.getDoc<Ticket>('ticket', ticket.id)?.inputs.filter(input => input.triggerId === follow.id))
        .toHaveLength(1)
      expect(runtime.store.getDoc<Thread>('thread', key)?.pending).not.toContain(follow.id)
      expect(runtime.store.listDocs<Ticket>('ticket').some(row => row.originTriggerId === follow.id)).toBe(false)
    }
  })

  it('rolls back Intake routing and disposition together on a mid-receive failure', () => {
    const runtime = start()
    const threadId = 'recovery/atomic'
    const seed = imTrigger({
      id: 'trg_atomic_seed',
      thread: threadId,
      text: '@ds-agent please fix the login timeout',
    })
    runtime.engine.receive(seed)
    const decision = runtime.engine.evaluateDue()[0]
    const ticket = runtime.store.getDoc<Ticket>('ticket', decision!.ticketId!)!
    const trigger = imTrigger({
      id: 'trg_atomic_intake',
      thread: threadId,
      text: 'the login timeout is still present',
      actor: 'alex',
    })
    const originalAddEvent = runtime.store.addEvent.bind(runtime.store)
    const bypassBefore = runtime.metrics.snapshot().counters['bypass.fanout']
    runtime.store.addEvent = (() => { throw new Error('injected Intake write failure') }) as typeof runtime.store.addEvent
    expect(() => runtime.engine.receive(trigger)).toThrow(/injected Intake write failure/)
    expect(runtime.metrics.snapshot().counters['bypass.fanout']).toBe(bypassBefore)
    runtime.store.addEvent = originalAddEvent
    expect(runtime.store.getDoc<Trigger>('trigger', trigger.id)).toBeUndefined()
    expect(runtime.store.getDoc<Disposition>('disposition', trigger.id)).toBeUndefined()
    expect(runtime.store.getDoc<Ticket>('ticket', ticket.id)?.inputs.some(input => input.triggerId === trigger.id)).toBe(false)

    expect(runtime.engine.receive(trigger)).toBe('stored')
    expect(runtime.store.getDoc<Disposition>('disposition', trigger.id)?.fanout).toEqual([ticket.id])
    expect(runtime.store.getDoc<Ticket>('ticket', ticket.id)?.inputs.filter(input => input.triggerId === trigger.id)).toHaveLength(1)
    expect(runtime.metrics.snapshot().counters['bypass.fanout']).toBe(bypassBefore + 1)
    expect(runtime.engine.receive(trigger)).toBe('duplicate')
    expect(runtime.metrics.snapshot().counters['bypass.fanout']).toBe(bypassBefore + 1)
  })

  it('fences an in-flight connector poll before Runtime.finish drains and closes Store', async () => {
    let rejectPage: ((error: Error) => void) | undefined
    let resolveStarted!: () => void
    const started = new Promise<void>(resolve => { resolveStarted = resolve })
    const runtime = freshRuntime({
      model: silentModel(),
      env: isolatedEnv(),
      watchdogIntervalMs: 60_000,
      connectors: normalizeConnectorConfig({
        enabled: true,
        google: { services: ['gmail'] },
        wake: { enabled: false, services: ['gmail'] },
      }),
      connectorApi: {
        async fetch() { return [] },
        fetchPage() {
          resolveStarted()
          return new Promise((_resolve, reject) => { rejectPage = reject })
        },
      },
    })
    runtimes.push(runtime)
    const poll = runtime.connectorWake.poll(Date.now())
    await started
    await runtime.finish()
    expect(runtime.store.isOpen).toBe(false)
    rejectPage?.(new Error('late provider rejection after shutdown'))
    await expect(poll).resolves.toMatchObject({ action: 'disabled', reason: 'stopping' })
    expect(runtime.log.text()).not.toContain('late provider rejection after shutdown')
  }, 5_000)

  it('routes a trigger to a shard, runs that router session, and places the worker on the mesh', async () => {
    const runtime = start({
      env: isolatedEnv({
        DS_AGENT_INSTANCE_ID: 'alpha',
        DS_AGENT_SHARDS: JSON.stringify([{ id: 'im', filter: 'source:im', priority: 10 }]),
      }),
    })
    expect(runtime.log.text()).toContain('[routing] shards configured count=1')
    runtime.ingest(imTrigger({
      id: 'trg_shard',
      thread: 'topic/shard',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    await runtime.jobsSettled()

    const disposition = runtime.store.getDoc<Disposition>('disposition', 'trg_shard')
    expect(disposition?.shards).toEqual(['im'])
    expect(runtime.log.text()).toContain('[routing] shards=im')
    expect(runtime.log.text()).toContain('MainSession start session=router:im')
    expect(runtime.log.text()).toContain('[mesh] place')

    const [ticket] = runtime.store.listDocs<Ticket>('ticket')
    expect(ticket?.assignments[0]?.node).toBe('alpha')
    expect(runtime.store.listEvents().some(event => event.type === 'assignment.placed')).toBe(true)
  })

  it('arbitrates overlapping shards into one ticket, one terminal decision, and one reply owner', async () => {
    const model = new ScriptedModel(request => {
      const prompt = lastPrompt(request)
      const lastUser = request.messages.map(message => message.role).lastIndexOf('user')
      const turn = request.messages.slice(lastUser)
      const repliedThisTurn = turn.some(message => message.role === 'tool' && message.name === 'reply_user')
      if (request.role === 'router') {
        if (prompt.startsWith('REPORT')) {
          return repliedThisTurn
            ? { text: 'router-done' }
            : {
              toolCalls: [{
                id: 'reply_result',
                name: 'reply_user',
                args: {
                  ticketId: field(prompt, 'ticketId'),
                  text: 'result from owner',
                  purpose: 'result',
                },
              }],
            }
        }
        if (!repliedThisTurn) {
          const shard = field(prompt, 'shard')
          return {
            toolCalls: [{
              id: `reply_${shard}`,
              name: 'reply_user',
              args: {
                ticketId: field(prompt, 'ticketId'),
                text: `launch reply from ${shard}`,
                purpose: 'launch',
              },
            }],
          }
        }
        return { text: 'router-idle' }
      }
      const reported = turn.some(message => message.role === 'tool' && message.name === 'report_to_router')
      if (!reported) {
        return {
          toolCalls: [{
            id: 'report_1',
            name: 'report_to_router',
            args: {
              ticketId: field(prompt, 'ticketId'),
              text: 'ready: login timeout fixed',
              deliver: true,
              kind: 'ready',
            },
          }],
        }
      }
      return { text: 'worker-done' }
    })

    const runtime = start({
      model,
      env: isolatedEnv({
        DS_AGENT_SHARDS: JSON.stringify([
          { id: 'ci', filter: 'source:im,text:timeout', priority: 5 },
          { id: 'topic', filter: 'thread:topic/overlap', priority: 5 },
          { id: 'later', filter: 'source:im', priority: 1 },
          { id: 'default' },
        ]),
      }),
    })

    runtime.ingest(imTrigger({
      id: 'trg_overlap',
      thread: 'topic/overlap',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    await runtime.jobsSettled()

    // Exactly the ordered matches: no default appended and no second disposition.
    const disposition = runtime.store.getDoc<Disposition>('disposition', 'trg_overlap')
    expect(disposition?.shards).toEqual(['ci', 'topic', 'later'])
    expect(runtime.store.listDocs<Disposition>('disposition')).toHaveLength(1)
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(1)

    // Every matching shard ran its Router session, in arbitration order, before the Worker.
    const log = runtime.log.text()
    const routerTurns = [...log.matchAll(/\[harness\] MainSession turn session=(router(?::\S+)?)/g)]
      .map(match => match[1])
    expect(routerTurns.slice(0, 3)).toEqual(['router:ci', 'router:topic', 'router:later'])
    const workerStart = log.indexOf('ExecutorSession start')
    expect(workerStart).toBeGreaterThan(0)
    for (const session of ['router:ci', 'router:topic', 'router:later']) {
      expect(log.indexOf(`MainSession turn session=${session}`)).toBeLessThan(workerStart)
    }

    // One terminal decision and one terminal ticket event for the trigger.
    expect(runtime.store.listDocs<{ triggerIds: string[]; kind: string }>('decision')).toEqual([
      expect.objectContaining({ triggerIds: ['trg_overlap'], kind: 'accept' }),
    ])
    const events = runtime.store.listEvents()
    expect(events.filter(event => event.type === 'decision.recorded')).toHaveLength(1)
    expect(events.filter(event => event.type === 'ticket.created')).toHaveLength(1)
    expect(events.filter(event => event.type === 'ticket.ended')).toHaveLength(1)

    // Both shards tried to speak at launch; only the first shard's reply exists.
    const replies = runtime.store.listReplies()
    const launch = replies.filter(reply => reply.purpose === 'launch')
    expect(launch).toHaveLength(1)
    expect(launch[0]!.text).toContain('launch reply from ci')
    const result = replies.filter(reply => reply.purpose === 'result')
    expect(result).toHaveLength(1)
    expect(result[0]!.text).toContain('result from owner')
    expect(runtime.store.listOutbox().filter(row => row.replyId === result[0]!.id)).toHaveLength(1)

    // The follow-up after the Worker report went to the first shard only.
    const journal = (session: string) => runtime.store
      .listMessages(session)
      .map(row => row.body)
      .join('\n')
    expect(journal('router:ci')).toContain('REPORT')
    expect(journal('router:topic')).not.toContain('REPORT')
    expect(journal('router')).not.toContain('REPORT')
    expect(journal('router:topic')).toContain('does not own ticket')
    expect(routerTurns.at(-1)).toBe('router:ci')
  })

  it('rejects non-owner shard replies and terminal calls without side effects', async () => {
    const runtime = start()
    const { triggerId, ticketId } = shardedTicket(runtime, 'trg_guard', ['ci', 'topic'])
    const tools = toolRegistry(runtime)
    const nonOwner = { sessionId: 'router:topic', role: 'router' as const }
    const beforeDecisions = runtime.store.listDocs<Decision>('decision').length
    const beforeReplies = runtime.store.listReplies().length
    const beforeOutbox = runtime.store.listOutbox().length

    await expect(tools.invoke(
      { id: 'g_stop', name: 'assess_trigger', args: { triggerId, ticketId, kind: 'stop', reason: 'hijack' } },
      nonOwner,
    )).rejects.toThrow(/does not own ticket/)
    await expect(tools.invoke(
      { id: 'g_unavailable_no_ticket', name: 'assess_trigger', args: { triggerId, kind: 'unavailable', reason: 'hijack' } },
      nonOwner,
    )).rejects.toThrow(/does not own ticket/)
    await expect(tools.invoke(
      { id: 'g_unavailable_ticket', name: 'assess_trigger', args: { triggerId, ticketId, kind: 'unavailable', reason: 'hijack' } },
      nonOwner,
    )).rejects.toThrow(/does not own ticket/)
    await expect(tools.invoke(
      { id: 'g_stop_worker', name: 'stop_worker', args: { ticketId } },
      nonOwner,
    )).rejects.toThrow(/does not own ticket/)
    await expect(tools.invoke(
      { id: 'g_reply', name: 'reply_user', args: { ticketId, text: 'hijack', purpose: 'result' } },
      nonOwner,
    )).rejects.toThrow(/does not own ticket/)

    expect(runtime.store.listDocs<Decision>('decision')).toHaveLength(beforeDecisions)
    expect(runtime.store.listReplies()).toHaveLength(beforeReplies)
    expect(runtime.store.listOutbox()).toHaveLength(beforeOutbox)
    expect(runtime.store.getDoc<Ticket>('ticket', ticketId)?.ended).toBeUndefined()

    const owner = { sessionId: 'router:ci', role: 'router' as const }
    await tools.invoke(
      { id: 'o_reply', name: 'reply_user', args: { ticketId, text: 'owner reply', purpose: 'result' } },
      owner,
    )
    expect(runtime.store.listReplies()).toHaveLength(beforeReplies + 1)
    await tools.invoke(
      { id: 'o_stop', name: 'assess_trigger', args: { triggerId, ticketId, kind: 'stop', reason: 'owner veto' } },
      owner,
    )
    expect(runtime.store.getDoc<Ticket>('ticket', ticketId)?.ended?.outcome).toBe('stopped')
    expect(runtime.store.listDocs<Decision>('decision').filter(decision =>
      decision.triggerIds.includes(triggerId) && decision.kind === 'stop')).toHaveLength(1)
  })

  it('rejects a trigger that does not belong to the supplied ticket', async () => {
    const runtime = start()
    const first = shardedTicket(runtime, 'trg_ci_owned', ['ci'], 'topic/first')
    const second = shardedTicket(runtime, 'trg_topic_owned', ['topic'], 'topic/second')
    const tools = toolRegistry(runtime)

    // router:topic owns the second ticket; origin-only resolution would wrongly allow this.
    await expect(tools.invoke(
      {
        id: 'borrow_first',
        name: 'assess_trigger',
        args: { triggerId: first.triggerId, ticketId: second.ticketId, kind: 'stop', reason: 'borrow' },
      },
      { sessionId: 'router:topic', role: 'router' },
    )).rejects.toThrow(/does not belong to ticket/)
    await expect(tools.invoke(
      {
        id: 'borrow_second',
        name: 'assess_trigger',
        args: { triggerId: second.triggerId, ticketId: first.ticketId, kind: 'stop', reason: 'borrow' },
      },
      { sessionId: 'router:ci', role: 'router' },
    )).rejects.toThrow(/does not belong to ticket/)

    expect(runtime.store.getDoc<Ticket>('ticket', first.ticketId)?.ended).toBeUndefined()
    expect(runtime.store.getDoc<Ticket>('ticket', second.ticketId)?.ended).toBeUndefined()
    expect(runtime.store.listDocs<Decision>('decision').filter(decision => decision.kind === 'stop')).toHaveLength(0)
  })

  it('fails closed when a ticket-scoped call cannot resolve an owner', async () => {
    const runtime = start()
    const tools = toolRegistry(runtime)
    const owner = { sessionId: 'router:ci', role: 'router' as const }
    const reply = (ticketId: string) => tools.invoke(
      { id: `reply_${ticketId}`, name: 'reply_user', args: { ticketId, text: 'x', purpose: 'result' } },
      owner,
    )

    await expect(reply('ticket_missing')).rejects.toThrow(/unknown ticket/)

    const base: Ticket = {
      id: 'ticket_orphan',
      title: 'orphan',
      brief: 'orphan',
      mandate: {
        strength: 'inferred',
        policyVersion: 'policy-v1',
        scope: 'orphan',
        actor: { source: 'im', id: 'alex' },
        basis: 'inferred',
      },
      threadKeys: ['im:topic/orphan'],
      channels: [{ source: 'im', thread: 'topic/orphan' }],
      inputs: [],
      assignments: [],
      speculative: false,
      originTriggerId: 'trg_absent',
      createdAt: new Date().toISOString(),
    }
    runtime.store.putDoc('ticket', base.id, base)
    await expect(reply(base.id)).rejects.toThrow(/no disposition for trigger trg_absent/)

    runtime.store.putDoc('ticket', 'ticket_no_origin', { ...base, id: 'ticket_no_origin', originTriggerId: '' })
    await expect(reply('ticket_no_origin')).rejects.toThrow(/has no origin trigger/)
  })

  it('records one terminal Router decision per trigger and skips repeated owner stops', async () => {
    const runtime = start()
    const { triggerId, ticketId } = shardedTicket(runtime, 'trg_idem', ['ci', 'topic'])
    const decisionsFor = () => runtime.store.listDocs<Decision>('decision')
      .filter(decision => decision.triggerIds.includes(triggerId))
    expect(decisionsFor().map(decision => decision.kind)).toEqual(['accept'])

    const first = runtime.engine.decide(triggerId, { kind: 'stop', ticketId, reason: 'first stop' })
    for (let step = 0; step < 9; step += 1) {
      expect(runtime.engine.decide(triggerId, {
        kind: 'stop',
        ticketId,
        reason: `repeat ${step}`,
      }).id).toBe(first.id)
    }

    // The accept is the upstream Eval record. The Router contributes exactly one terminal decision.
    expect(decisionsFor().filter(decision => decision.kind === 'stop')).toHaveLength(1)
    expect(decisionsFor().filter(decision => decision.kind === 'accept')).toHaveLength(1)
    expect(decisionsFor()).toHaveLength(2)
    expect(runtime.log.text()).toContain(`Evals.decide skipped triggerId=${triggerId} kind=stop`)
  })

  it('ignores malformed shard config instead of failing startup', () => {
    const runtime = start({ env: isolatedEnv({ DS_AGENT_SHARDS: 'not-json' }) })
    expect(runtime.log.text()).toContain('DS_AGENT_SHARDS ignored')
    expect(runtime.routerShards.route(imTrigger({
      id: 'trg_cfg',
      thread: 'topic/cfg',
      text: '@ds-agent please fix the login timeout',
    }))).toEqual(['default'])
  })

  it('writes a long-term memory on ticket end and recalls it on the next ticket', async () => {
    const prompts: string[] = []
    const runtime = start({ model: reportingModel(prompts) })

    runtime.ingest(imTrigger({
      id: 'trg_mem_1',
      thread: 'topic/mem-1',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    await runtime.jobsSettled()
    const first = runtime.store.listDocs<Ticket>('ticket')[0]
    expect(first?.ended).toBeDefined()
    const memory = runtime.store.getDoc<{ id: string }>('ltm', `ltm_${first!.id}`)
    expect(memory).toBeDefined()

    runtime.ingest(imTrigger({
      id: 'trg_mem_2',
      thread: 'topic/mem-2',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    await runtime.jobsSettled()

    const secondPrompt = prompts.at(-1) ?? ''
    expect(secondPrompt).toContain(`memory=ltm_${first!.id}`)
    expect(secondPrompt).toContain('login timeout')
    expect(runtime.metrics.snapshot().counters['memory.remembered']).toBeGreaterThanOrEqual(2)
    expect(runtime.metrics.snapshot().counters['memory.recalled']).toBeGreaterThanOrEqual(1)
  })

  it('publishes ticket lifecycle events to the lifecycle bus', async () => {
    const runtime = start({ model: reportingModel() })
    const created: unknown[] = []
    const ended: unknown[] = []
    runtime.lifecycle.subscribe('ticket.created', event => created.push(event))
    runtime.lifecycle.subscribe('ticket.ended', event => ended.push(event))

    runtime.ingest(imTrigger({
      id: 'trg_shell',
      thread: 'topic/shell',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    await runtime.jobsSettled()

    expect(created).toHaveLength(1)
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ kind: 'ticket.ended', payload: { outcome: 'ready' } })
  })

  it('turns a local A2A envelope into a normal filtered trigger', async () => {
    const runtime = start({ env: isolatedEnv({ DS_AGENT_INSTANCE_ID: 'alpha' }) })
    const delivery = runtime.sendA2A('alpha', {
      text: '@ds-agent please fix the login timeout on checkout',
      thread: 'a2a/thread-1',
    })
    expect(delivery.status).toBe('delivered')
    expect(delivery.delivered).toBe(1)
    await runtime.jobsSettled()

    expect(runtime.log.text()).toContain('[a2a] received')
    const ticket = runtime.store.listDocs<Ticket>('ticket')[0]
    expect(ticket?.threadKeys).toEqual(['a2a:a2a/thread-1'])
    expect(runtime.a2aRouter.list()).toHaveLength(1)

    const unroutable = runtime.sendA2A('beta', { text: 'no listener' })
    expect(unroutable.status).toBe('unroutable')
    expect(unroutable.persisted).toBe(true)
    expect(runtime.a2aRouter.list()).toHaveLength(2)
  })

  it('publishes pause and guidance as lifecycle events', async () => {
    const runtime = start()
    runtime.ingest(imTrigger({
      id: 'trg_shell_live',
      thread: 'topic/shell-live',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    await runtime.jobsSettled()
    const ticket = runtime.store.listDocs<Ticket>('ticket')[0]!
    const events: unknown[] = []
    runtime.lifecycle.subscribe('ticket.paused', event => events.push(event))
    runtime.lifecycle.subscribe('ticket.guidance', event => events.push(event))

    runtime.pause(ticket.id, { reason: 'waiting on staging' })
    runtime.intervene(ticket.id, 'use the staging database')

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ kind: 'ticket.paused', payload: { ticketId: ticket.id } })
    expect(events[1]).toMatchObject({ kind: 'ticket.guidance', payload: { ticketId: ticket.id } })
    expect(runtime.lifecycle.snapshot(1)).toHaveLength(1)
  })

  it('rejects a malformed A2A envelope', () => {
    const runtime = start()
    expect(() => runtime.sendA2A('', { text: 'x' })).toThrow(/to address/)
    expect(() => runtime.sendA2A('alpha', { text: 'x'.repeat(70_000) })).toThrow(/exceeds/)
  })

  it('makes the single-session bake-off baseline observable in metrics', async () => {
    const dual = start()
    dual.ingest(imTrigger({
      id: 'trg_dual',
      thread: 'topic/dual',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    await dual.jobsSettled()

    const single = start({ singleSession: true })
    single.ingest(imTrigger({
      id: 'trg_single',
      thread: 'topic/single',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    await single.jobsSettled()

    const dualCalls = dual.metrics.snapshot().counters['model.call']
    const singleCalls = single.metrics.snapshot().counters['model.call']
    expect(singleCalls).toBe(1)
    expect(dualCalls).toBeGreaterThan(singleCalls)
    expect(single.log.text()).toContain('[harness] single-session')
    expect(single.log.text()).not.toContain('MainSession start')
  })
})

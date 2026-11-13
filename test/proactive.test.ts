import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  OUTBOX_RETRY_BASE_KEY,
  Outbox,
  PROACTIVE_RETRY_BASE_MS,
  type OutboundAdapter,
} from '../src/channels/outbox-adapter.ts'
import {
  loadProactiveConfig,
  normalizeProactiveConfig,
  PROACTIVE_FILE,
  PROACTIVE_TRIGGER_PREFIX,
  ProactiveScheduler,
  type ProactiveConfig,
} from '../src/harness/proactive.ts'
import { Runtime } from '../src/runtime.ts'
import type { Ticket, Trigger } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'
import { field, lastPrompt, ScriptedModel } from './scripted-model.ts'

const homes: string[] = []
const stores: Store[] = []
const runtimes: Runtime[] = []

/** 2026-11-05 10:00 Asia/Shanghai. */
const T0 = Date.parse('2026-11-05T02:00:00.000Z')
const MIN = 60_000
const THREAD = 'feishu:oc_owner'

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-proactive-'))
  homes.push(dir)
  return dir
}

function tempStore(): Store {
  const store = new Store(tempHome())
  stores.push(store)
  return store
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    runtime.daemon.stop()
    if (runtime.store.isOpen) await runtime.finish().catch(() => undefined)
  }
  for (const store of stores.splice(0)) {
    if (store.isOpen) store.close()
  }
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function config(overrides: Record<string, unknown> = {}): ProactiveConfig {
  return normalizeProactiveConfig({
    enabled: true,
    chatId: 'oc_owner',
    ...overrides,
  })
}

function realTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'feishu_owner_1',
    source: 'im',
    threads: [{ source: 'im', id: THREAD }],
    actor: { source: 'im', id: 'ou_owner' },
    human: true,
    addressed: 'direct',
    at: new Date(T0 - 2 * 60 * MIN).toISOString(),
    text: '帮我看一下附件那件事',
    channel: {
      source: 'im',
      thread: THREAD,
      address: {
        provider: 'feishu',
        chat_id: 'oc_owner',
        group: 'oc_owner',
        message_id: 'om_1',
      },
    },
    meta: {},
    ...overrides,
  }
}

function openTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'ticket_seed',
    title: '核对附件',
    brief: '帮我看一下附件那件事',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-v1',
      scope: '核对附件',
      actor: { source: 'im', id: 'ou_owner' },
      basis: 'addressed',
    },
    threadKeys: [`im:${THREAD}`],
    channels: [{
      source: 'im',
      thread: THREAD,
      address: { provider: 'feishu', chat_id: 'oc_owner', group: 'oc_owner' },
    }],
    inputs: [],
    assignments: [{
      id: 'asg_seed',
      state: 'ended',
      speculative: false,
      endedAt: new Date(T0 - 60 * MIN).toISOString(),
      report: {
        kind: 'waiting',
        text: '已收到附件，等待确认版本',
        deliver: false,
        at: new Date(T0 - 60 * MIN).toISOString(),
        question: '你希望我按哪一版继续？',
      },
    }],
    speculative: false,
    originTriggerId: 'feishu_owner_1',
    createdAt: new Date(T0 - 3 * 60 * MIN).toISOString(),
    ...overrides,
  }
}

function seed(store: Store, options: { trigger?: Trigger; ticket?: Ticket } = {}): void {
  const trigger = options.trigger ?? realTrigger()
  store.putDoc('trigger', trigger.id, trigger)
  store.putDoc('disposition', trigger.id, { fanout: [], at: trigger.at })
  if (options.ticket) store.putDoc('ticket', options.ticket.id, options.ticket)
}

function scheduler(
  store: Store,
  options: {
    config?: ProactiveConfig
    now?: number
    env?: NodeJS.ProcessEnv
    memoryFor?: (ticket: Ticket) => string[]
  } = {},
): { scheduler: ProactiveScheduler; fired: Trigger[]; lines: string[] } {
  const fired: Trigger[] = []
  const lines: string[] = []
  const scheduler = new ProactiveScheduler({
    now: () => options.now ?? T0,
    store,
    config: options.config ?? config(),
    env: options.env ?? {},
    ...(options.memoryFor ? { memoryFor: options.memoryFor } : {}),
    fire: trigger => { fired.push(trigger) },
    log: line => { lines.push(line) },
  })
  return { scheduler, fired, lines }
}

describe('proactive configuration', () => {
  it('is disabled with the safe defaults when the file is absent', () => {
    expect(loadProactiveConfig(tempHome())).toEqual({
      enabled: false,
      intervalMinutes: 30,
      timezone: 'Asia/Shanghai',
      quietStart: '23:00',
      quietEnd: '08:00',
      minIntervalMinutes: 180,
      maxPerDay: 2,
      activeThreadCooldownMinutes: 30,
    })
  })

  it('reads the owner file and accepts the documented overrides', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, PROACTIVE_FILE), JSON.stringify({
      enabled: true,
      intervalMinutes: 45,
      quietStart: '22:30',
      quietEnd: '07:30',
      minIntervalMinutes: 240,
      maxPerDay: 1,
      thread: THREAD,
      chatId: 'oc_owner',
    }))
    expect(loadProactiveConfig(home)).toMatchObject({
      enabled: true,
      intervalMinutes: 45,
      quietStart: '22:30',
      quietEnd: '07:30',
      minIntervalMinutes: 240,
      maxPerDay: 1,
      thread: THREAD,
      chatId: 'oc_owner',
    })
  })

  it('rejects malformed values instead of silently changing behavior', () => {
    expect(() => normalizeProactiveConfig({ enabled: 'yes' })).toThrow(/enabled/)
    expect(() => normalizeProactiveConfig({ intervalMinutes: 1 })).toThrow(/intervalMinutes/)
    expect(() => normalizeProactiveConfig({ quietStart: '8:00' })).toThrow(/quietStart/)
    expect(() => normalizeProactiveConfig({ timezone: 'America/New_York' })).toThrow(/timezone/)
    expect(() => normalizeProactiveConfig({ shell: 'rm -rf /' })).toThrow(/unknown key/)
  })

  it('does not write the owner config when it evaluates', () => {
    const store = tempStore()
    const home = path.dirname(store.path)
    const file = path.join(home, PROACTIVE_FILE)
    fs.writeFileSync(file, JSON.stringify({ enabled: true, chatId: 'oc_owner' }))
    const before = fs.readFileSync(file, 'utf8')
    seed(store, { ticket: openTicket() })
    const { scheduler: runner } = scheduler(store)
    runner.tick(T0)
    runner.tick(T0 + 31 * MIN)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })
})

describe('idle self-wake policy', () => {
  it('arms first and fires only when the interval is due', () => {
    const store = tempStore()
    seed(store, { ticket: openTicket() })
    const { scheduler: runner, fired } = scheduler(store)

    expect(runner.tick(T0)).toMatchObject({ action: 'armed' })
    expect(runner.tick(T0 + 29 * MIN).action).toBe('not-due')
    expect(fired).toHaveLength(0)

    const result = runner.tick(T0 + 30 * MIN)
    expect(result.action).toBe('contact')
    expect(fired).toHaveLength(1)
    const trigger = fired[0]!
    expect(trigger.id.startsWith(PROACTIVE_TRIGGER_PREFIX)).toBe(true)
    expect(trigger.addressed).toBe('direct')
    expect(trigger.human).toBe(true)
    expect(trigger.actor.id).toBe('ou_owner')
    expect(trigger.channel?.thread).toBe(THREAD)
    expect(trigger.channel?.address?.proactive).toBe('1')
    // An old message id must not turn the proactive send into a reply to it.
    expect(trigger.channel?.address?.message_id).toBeUndefined()
    expect(trigger.text).toContain('你希望我按哪一版继续？')
    expect(trigger.text).not.toContain('我在')
  })

  it('stays silent when there is no useful new fact', () => {
    const store = tempStore()
    // An open ticket with no question, approval, or blocked report is not a reason.
    seed(store, {
      ticket: openTicket({
        assignments: [{ id: 'asg_seed', state: 'running', speculative: false }],
      }),
    })
    const { scheduler: runner, fired, lines } = scheduler(store)
    runner.tick(T0)
    expect(runner.tick(T0 + 31 * MIN).action).toBe('silent')
    expect(fired).toHaveLength(0)
    expect(lines.some(line => line.includes('silent reason=no-useful-signal'))).toBe(true)
  })

  it('stays silent when there is no real session to reply into', () => {
    const store = tempStore()
    store.putDoc('ticket', 'ticket_seed', openTicket())
    const { scheduler: runner, fired } = scheduler(store)
    runner.tick(T0)
    expect(runner.tick(T0 + 31 * MIN).action).toBe('silent')
    expect(fired).toHaveLength(0)
  })

  it('does not interrupt a thread the owner used recently', () => {
    const store = tempStore()
    seed(store, {
      trigger: realTrigger({ id: 'feishu_owner_recent', at: new Date(T0 + 26 * MIN).toISOString() }),
      ticket: openTicket(),
    })
    const { scheduler: runner, fired } = scheduler(store)
    runner.tick(T0)
    expect(runner.tick(T0 + 31 * MIN).action).toBe('silent')
    expect(fired).toHaveLength(0)
  })

  it('observes quiet hours in Asia/Shanghai', () => {
    const store = tempStore()
    seed(store, { ticket: openTicket() })
    const quiet = Date.parse('2026-11-04T15:30:00.000Z') // 23:30 Shanghai
    const { scheduler: runner, fired } = scheduler(store)
    runner.tick(quiet - 31 * MIN)
    expect(runner.tick(quiet).action).toBe('quiet-hours')
    expect(fired).toHaveLength(0)
  })

  it('enforces the minimum interval between contacts', () => {
    const store = tempStore()
    seed(store, { ticket: openTicket() })
    store.putDoc('proactive', 'state', {
      lastCheckAt: T0 - 31 * MIN,
      lastContactAt: T0 - 60 * MIN,
      contacts: [{ at: T0 - 60 * MIN, triggerId: 'old', ticketId: 'ticket_seed', thread: THREAD }],
    })
    const { scheduler: runner, fired } = scheduler(store)
    expect(runner.tick(T0).action).toBe('min-interval')
    expect(fired).toHaveLength(0)
  })

  it('enforces the daily cap on the Shanghai day', () => {
    const store = tempStore()
    seed(store, { ticket: openTicket() })
    store.putDoc('proactive', 'state', {
      lastCheckAt: T0 - 31 * MIN,
      lastContactAt: T0 - 5 * 60 * MIN,
      contacts: [
        { at: T0 - 6 * 60 * MIN, triggerId: 'a', ticketId: 'ticket_a', thread: THREAD },
        { at: T0 - 4 * 60 * MIN, triggerId: 'b', ticketId: 'ticket_b', thread: THREAD },
      ],
    })
    const { scheduler: runner, fired } = scheduler(store)
    expect(runner.tick(T0).action).toBe('daily-cap')
    expect(fired).toHaveLength(0)
  })

  it('makes one round after a long gap and does not burst on restart', () => {
    const store = tempStore()
    seed(store, { ticket: openTicket() })
    const first = scheduler(store)
    first.scheduler.tick(T0)
    expect(first.scheduler.tick(T0 + 5 * 60 * MIN).action).toBe('contact')
    expect(first.fired).toHaveLength(1)

    // A new process sees the persisted check and does not replay the gap.
    const second = scheduler(store)
    expect(second.scheduler.tick(T0 + 5 * 60 * MIN).action).toBe('not-due')
    expect(second.fired).toHaveLength(0)
  })

  it('never auto-approves an irreversible pending action', () => {
    const store = tempStore()
    const ticket = openTicket({
      assignments: [{
        id: 'asg_seed',
        state: 'ended',
        speculative: false,
        endedAt: new Date(T0 - 60 * MIN).toISOString(),
        report: {
          kind: 'waiting',
          text: '等待所有者确认后发送',
          deliver: false,
          at: new Date(T0 - 60 * MIN).toISOString(),
        },
      }],
      collab: {
        guidance: [],
        resumes: [],
        approvals: [{
          id: 'ap_1',
          at: new Date(T0 - 30 * MIN).toISOString(),
          action: '向客户发送最终报价邮件',
          reason: '不可撤销的外部发送',
          requestedBy: 'worker_ticket_seed',
          status: 'pending',
        }],
      },
    })
    seed(store, { ticket })
    const { scheduler: runner, fired } = scheduler(store)
    runner.tick(T0)
    expect(runner.tick(T0 + 31 * MIN).action).toBe('contact')
    expect(fired).toHaveLength(1)
    expect(fired[0]!.text).toContain('等你确认')
    expect(fired[0]!.text).not.toMatch(/已批准|approved/i)

    const after = store.getDoc<Ticket>('ticket', ticket.id)!
    expect(after.collab?.approvals?.[0]?.status).toBe('pending')
    expect(store.listDocs('decision')).toHaveLength(0)
  })

  it('uses only an admitted private thread, never a group or a new recipient', () => {
    const store = tempStore()
    const groupTrigger = realTrigger({
      id: 'feishu_group_1',
      threads: [{ source: 'im', id: 'feishu:oc_group' }],
      channel: {
        source: 'im',
        thread: 'feishu:oc_group',
        address: { provider: 'feishu', chat_id: 'oc_group', group: 'oc_group', message_id: 'om_g' },
      },
    })
    store.putDoc('trigger', groupTrigger.id, groupTrigger)
    store.putDoc('disposition', groupTrigger.id, { fanout: [], at: groupTrigger.at })
    store.putDoc('ticket', 'ticket_group', openTicket({
      id: 'ticket_group',
      threadKeys: ['im:feishu:oc_group'],
      channels: [{
        source: 'im',
        thread: 'feishu:oc_group',
        address: { provider: 'feishu', chat_id: 'oc_group', group: 'oc_group' },
      }],
    }))
    const { scheduler: runner, fired } = scheduler(store)
    runner.tick(T0)
    expect(runner.tick(T0 + 31 * MIN).action).toBe('silent')
    expect(fired).toHaveLength(0)
  })

  it('honors an explicitly configured private thread and does not jump elsewhere', () => {
    const store = tempStore()
    seed(store, { ticket: openTicket() })
    store.putDoc('trigger', 'feishu_other_1', realTrigger({
      id: 'feishu_other_1',
      threads: [{ source: 'im', id: 'feishu:oc_other' }],
      channel: {
        source: 'im',
        thread: 'feishu:oc_other',
        address: { provider: 'feishu', chat_id: 'oc_other', group: 'oc_other' },
      },
    }))
    const { scheduler: runner, fired } = scheduler(store, {
      config: config({ thread: 'feishu:oc_other' }),
    })
    runner.tick(T0)
    expect(runner.tick(T0 + 31 * MIN).action).toBe('silent')
    expect(fired).toHaveLength(0)
  })

  it('includes scoped memory only when it shares a token with the fact', () => {
    const store = tempStore()
    seed(store, { ticket: openTicket() })
    const { scheduler: runner, fired } = scheduler(store, {
      memoryFor: () => ['附件 v2 是客户最后确认的版本', '一条无关的记忆'],
    })
    runner.tick(T0)
    expect(runner.tick(T0 + 31 * MIN).action).toBe('contact')
    expect(fired[0]!.text).toContain('relatedMemory=附件 v2')
    expect(fired[0]!.text).not.toContain('无关')
  })
})

describe('idle self-wake runtime path', () => {
  function proactiveModel(): ScriptedModel {
    return new ScriptedModel(request => {
      if (request.role !== 'router') return { text: 'worker-should-not-run' }
      const prompt = lastPrompt(request)
      if (!prompt.includes('proactive=true')) return { text: 'router-idle' }
      const lastUser = request.messages.map(message => message.role).lastIndexOf('user')
      const turn = request.messages.slice(lastUser)
      const replied = turn.some(message => message.role === 'tool' && message.name === 'reply_user')
      if (!replied) {
        return {
          toolCalls: [{
            id: 'reply_proactive',
            name: 'reply_user',
            args: {
              ticketId: field(prompt, 'ticketId'),
              text: '那件附件还搁着。你要是有空，我可以先把现状整理好放这儿；没空就先放着，不用回。',
              purpose: 'proactive',
            },
          }],
        }
      }
      return { text: 'router-done' }
    })
  }

  function runtimeWithProactive(): { runtime: Runtime; clock: { at: number } } {
    const home = tempHome()
    const clock = { at: T0 }
    const runtime = Runtime.create({
      home,
      model: proactiveModel(),
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      now: () => new Date(clock.at).toISOString(),
      proactive: config(),
    })
    runtimes.push(runtime)
    const store = runtime.store
    seed(store, { ticket: openTicket() })
    return { runtime, clock }
  }

  it('injects one trigger, sends through the outbox fake, and never starts a Worker', async () => {
    const { runtime, clock } = runtimeWithProactive()

    runtime.daemon.tick(clock.at)
    clock.at += 31 * MIN
    runtime.daemon.tick(clock.at)
    await runtime.jobsSettled()

    const triggers = runtime.store.listDocs<Trigger>('trigger')
    const proactive = triggers.filter(trigger => trigger.id.startsWith(PROACTIVE_TRIGGER_PREFIX))
    expect(proactive).toHaveLength(1)
    expect(proactive[0]!.channel?.address?.proactive).toBe('1')

    const ticket = runtime.store.listDocs<Ticket>('ticket')
      .find(item => item.originTriggerId === proactive[0]!.id)
    expect(ticket).toBeTruthy()
    expect(ticket!.ended).toBeTruthy()
    expect(runtime.store.listSessions().some(session => session.role === 'worker')).toBe(false)

    const pending = runtime.store.listOutbox('pending')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.channel).toBe('im')
    expect(pending[0]!.target.chat_id).toBe('oc_owner')
    expect(pending[0]!.target[OUTBOX_RETRY_BASE_KEY]).toBe(String(PROACTIVE_RETRY_BASE_MS))
    expect(pending[0]!.text).toContain('附件')

    const sent: { chat?: string; text: string }[] = []
    const adapter: OutboundAdapter = {
      channel: 'im',
      send: async row => {
        sent.push({ chat: row.target.chat_id, text: row.text })
        return { externalId: 'om_proactive_1' }
      },
    }
    const result = await new Outbox(runtime.store, [adapter]).flush()
    expect(result.sent).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.chat).toBe('oc_owner')
    expect(sent[0]!.text).toContain('附件')
  })

  it('is disabled unless proactive.json enables it, even when a fact exists', () => {
    const home = tempHome()
    const runtime = Runtime.create({
      home,
      model: proactiveModel(),
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      now: () => new Date(T0).toISOString(),
    })
    runtimes.push(runtime)
    seed(runtime.store, { ticket: openTicket() })
    expect(runtime.proactive.tick(T0).action).toBe('disabled')
    expect(runtime.store.listDocs('trigger').filter(item =>
      (item as Trigger).id.startsWith(PROACTIVE_TRIGGER_PREFIX))).toHaveLength(0)
  })

  it('combines with DROP_SELF so a bot echo cannot re-enter ingress', () => {
    const home = tempHome()
    const runtime = Runtime.create({
      home,
      model: proactiveModel(),
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      admission: { dropSelf: ['ou_bot'] },
      now: () => new Date(T0).toISOString(),
    })
    runtimes.push(runtime)
    const echo: Trigger = {
      ...realTrigger({ id: 'feishu_bot_echo' }),
      actor: { source: 'im', id: 'ou_bot' },
      text: '那件附件还搁着。你要是有空，我可以先把现状整理好放这儿；没空就先放着，不用回。',
    }
    expect(runtime.ingest(echo)).toBe('filtered')
    expect(runtime.log.text()).toContain('self-drop')
  })
})

describe('proactive outbox failure handling', () => {
  it('backs off for minutes, does not retry immediately, and never sends twice', async () => {
    const store = tempStore()
    store.enqueueOutbox({
      id: 'outbox_proactive',
      replyId: 'reply_proactive',
      ticketId: 'ticket_proactive',
      channel: 'im',
      thread: THREAD,
      target: {
        provider: 'feishu',
        chat_id: 'oc_owner',
        [OUTBOX_RETRY_BASE_KEY]: String(PROACTIVE_RETRY_BASE_MS),
      },
      text: '附件那件还搁着',
      status: 'pending',
      createdAt: new Date().toISOString(),
    })
    let calls = 0
    const adapter: OutboundAdapter = {
      channel: 'im',
      send: async () => {
        calls += 1
        throw new Error('network down')
      },
    }
    const outbox = new Outbox(store, [adapter])
    const first = await outbox.flush()
    expect(first).toEqual({ sent: 0, failed: 0, pending: 1 })
    expect(calls).toBe(1)
    const after = store.listOutbox()[0]!
    expect(after.status).toBe('pending')
    expect(after.attempts).toBe(1)
    expect(Date.parse(after.nextAttemptAt!) - Date.now()).toBeGreaterThanOrEqual(15 * MIN)

    // Not due yet: a restart/reflush must not hammer the channel.
    await outbox.flush()
    expect(calls).toBe(1)
    store.close()
  })
})

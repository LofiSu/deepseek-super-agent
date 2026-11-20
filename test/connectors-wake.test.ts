import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Replies } from '../src/core/replies.ts'
import type { Host } from '../src/core/host.ts'
import { routerPromptFor } from '../src/harness/loop.ts'
import { Metrics } from '../src/metrics/metrics.ts'
import { normalizeProactiveConfig } from '../src/harness/proactive.ts'
import { FeishuClient, FeishuSource, feishuTriggerFromMessage } from '../src/channels/feishu.ts'
import { filterTrigger, ruleClassify } from '../src/ingress/filter.ts'
import { admissionRulesFromEnv } from '../src/runtime.ts'
import {
  CONNECTOR_TRIGGER_PREFIX,
  ConnectorWakeScheduler,
  connectorTrigger,
  isConnectorWakeTicket,
  loadConnectorWakeState,
  type ConnectorPendingWake,
} from '../src/connectors/wake.ts'
import { normalizeConnectorConfig } from '../src/connectors/config.ts'
import { ConnectorIndex } from '../src/connectors/index-store.ts'
import { GoogleInvalidPageTokenError, type GoogleWorkspaceApi } from '../src/connectors/google.ts'
import type { ConnectorDraft } from '../src/connectors/types.ts'
import type { Disposition, Ticket, Trigger } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'

const homes: string[] = []
const stores: Store[] = []

/** 2026-11-05 10:00 UTC, outside the default Shanghai quiet window. */
const T0 = Date.parse('2026-11-05T10:00:00.000Z')
const MIN = 60_000

function setup(): { home: string; store: Store; index: ConnectorIndex } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-connectors-wake-'))
  homes.push(home)
  const store = new Store(home)
  stores.push(store)
  return {
    home,
    store,
    index: new ConnectorIndex(store, { redact: text => text, now: () => new Date(T0) }),
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) if (store.isOpen) store.close()
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function seedOwnerThread(store: Store): void {
  const at = new Date(T0 - 60 * MIN).toISOString()
  const trigger: Trigger = {
    id: 'trg_cli_seed',
    source: 'cli',
    threads: [{ source: 'cli', id: 'local' }],
    actor: { source: 'cli', id: 'you' },
    human: true,
    addressed: 'direct',
    at,
    text: 'hello',
    channel: { source: 'cli', thread: 'local' },
    meta: {},
  }
  store.putDoc('trigger', trigger.id, trigger)
  const disposition: Disposition = { at, fanout: [], context: [] }
  store.putDoc('disposition', trigger.id, disposition)
}

function draft(overrides: Partial<ConnectorDraft> = {}): ConnectorDraft {
  return {
    service: 'gmail',
    kind: 'message',
    externalId: 'message-1',
    title: 'Invoice for November',
    text: 'from=billing@example.com The invoice is attached',
    occurredAt: new Date(T0 - 5 * MIN).toISOString(),
    updatedAt: new Date(T0 - 5 * MIN).toISOString(),
    wake: true,
    wakeReason: 'unread important mail',
    ...overrides,
  }
}

function pendingWake(index: ConnectorIndex, at: number, suffix: string): ConnectorPendingWake {
  const record = index.upsert([draft({ externalId: `pending-${suffix}` })]).records[0]!
  const trigger = connectorTrigger(record, {
    channel: { source: 'cli', thread: 'local' },
    actor: { source: 'cli', id: 'you' },
  }, at)
  return { at, trigger, recordId: record.id, service: record.service }
}

function scheduler(input: {
  store: Store
  index: ConnectorIndex
  api: GoogleWorkspaceApi
  config?: Record<string, unknown>
  admission?: { actors?: string[]; dropSelf?: string[]; groups?: string[] }
  quiet?: { quietStart: string; quietEnd: string; timezone: string }
  now?: () => number
  env?: NodeJS.ProcessEnv
}): { runner: ConnectorWakeScheduler; fired: Trigger[]; lines: string[] } {
  const fired: Trigger[] = []
  const lines: string[] = []
  const overrides = input.config ?? {}
  const google = (overrides.google ?? {}) as Record<string, unknown>
  const poll = (overrides.poll ?? {}) as Record<string, unknown>
  const wake = (overrides.wake ?? {}) as Record<string, unknown>
  const config = normalizeConnectorConfig({
    enabled: true,
    google: { services: ['gmail', 'calendar', 'docs'], ...google },
    poll: { intervalMinutes: 15, ...poll },
    wake: {
      enabled: true,
      services: ['gmail', 'calendar', 'docs'],
      source: 'cli',
      thread: 'local',
      minIntervalMinutes: 15,
      maxPerDay: 3,
      ...wake,
    },
  })
  const runner = new ConnectorWakeScheduler({
    now: input.now ?? (() => T0),
    store: input.store,
    config,
    index: input.index,
    api: input.api,
    proactive: normalizeProactiveConfig({
      quietStart: '23:00',
      quietEnd: '08:00',
      timezone: 'UTC',
      ...(input.quiet ?? {}),
    }),
    ...(input.admission ? { admission: input.admission } : {}),
    ...(input.env ? { env: input.env } : {}),
    fire: trigger => {
      fired.push(trigger)
      input.store.putDoc('trigger', trigger.id, trigger)
      input.store.putDoc('disposition', trigger.id, {
        at: trigger.at,
        fanout: [],
        context: [],
      } satisfies Disposition)
    },
    log: line => { lines.push(line) },
  })
  return { runner, fired, lines }
}

async function seedFeishuPollTrigger(
  store: Store,
  chatMode: string | undefined,
  options: {
    visibility?: string
    lookupError?: boolean
    actor?: string
    allowedActor?: string
    allowedGroup?: string
  } = {},
): Promise<{ trigger: Trigger; admitted: boolean; denial?: string }> {
  const config = {
    appId: 'app',
    appSecret: 'secret',
    baseUrl: 'https://open.feishu.cn',
    chatId: 'oc_owner',
  }
  const fetchImpl = async (url: string): Promise<Response> => {
    let body: unknown
    if (url.includes('tenant_access_token')) {
      body = { code: 0, tenant_access_token: 'test-token', expire: 7200 }
    } else if (url.includes('/im/v1/chats/')) {
      body = options.lookupError
        ? { code: 230002, msg: 'permission denied' }
        : { code: 0, data: {
          ...(chatMode === undefined ? {} : { chat_mode: chatMode }),
          ...(options.visibility === undefined ? {} : { chat_type: options.visibility }),
        } }
    } else {
      body = {
        code: 0,
        data: {
          has_more: false,
          items: [{
            message_id: 'om_polled_owner',
            chat_id: 'oc_owner',
            msg_type: 'text',
            body: { content: JSON.stringify({ text: '@ds-agent please investigate this issue' }) },
            create_time: String(T0 - 60 * MIN),
            sender: { id: options.actor ?? 'ou_owner', sender_type: 'user' },
          }],
        },
      }
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const source = new FeishuSource(new FeishuClient(config, fetchImpl), 'oc_owner', {
    sinceMs: T0 - 60 * MIN,
    config,
  })
  const [trigger] = await source.pull()
  if (!trigger) throw new Error('expected a Feishu poll trigger')
  const rules = admissionRulesFromEnv({
    DS_AGENT_GROUP_ALLOWLIST: options.allowedGroup ?? 'oc_owner',
    DS_AGENT_ACTOR_ALLOWLIST: options.allowedActor ?? 'ou_owner',
  })
  const verdict = filterTrigger(trigger, { name: 'test-rules', classify: ruleClassify }, rules)
  store.putDoc('trigger', trigger.id, trigger)
  store.putDoc('disposition', trigger.id, {
    at: trigger.at,
    fanout: [],
    context: [],
    ...(verdict.action === 'drop' ? { filtered: `${verdict.layer}:${verdict.reason}` } : {}),
  } satisfies Disposition)
  return {
    trigger,
    admitted: verdict.action === 'pass',
    ...(verdict.action === 'drop' ? { denial: `${verdict.layer}:${verdict.reason}` } : {}),
  }
}

function fakeApi(records: readonly ConnectorDraft[], failures: readonly string[] = []): GoogleWorkspaceApi {
  return {
    async fetch(service) {
      if (failures.includes(service)) throw new Error(`provider ${service} unavailable`)
      return records.filter(record => record.service === service)
    },
  }
}

describe('connector wake scheduler', () => {
  it('backfills the index first, then wakes once for a useful record', async () => {
    const { store, index } = setup()
    seedOwnerThread(store)
    const records = [draft()]
    const { runner, fired, lines } = scheduler({ store, index, api: fakeApi(records) })

    const backfill = await runner.poll(T0)
    expect(backfill.action).toBe('backfill')
    expect(backfill.indexed).toBe(1)
    expect(fired).toHaveLength(0)
    expect(index.stats().count).toBe(1)
    records[0]!.updatedAt = new Date(T0 + MIN).toISOString()

    const first = await runner.poll(T0 + 16 * MIN)
    expect(first.action).toBe('wake')
    expect(fired).toHaveLength(1)
    const trigger = fired[0]!
    expect(trigger.id.startsWith(CONNECTOR_TRIGGER_PREFIX)).toBe(true)
    expect(trigger.human).toBe(false)
    expect(trigger.addressed).toBe('direct')
    expect(trigger.actor).toEqual({ source: 'cli', id: 'you' })
    expect(trigger.channel?.address?.connector).toBe('1')
    expect(trigger.text).toContain('CONNECTOR_EVENT')
    expect(trigger.text).toContain('service=gmail')
    expect(trigger.text).toContain('fact=Invoice for November')
    expect(trigger.text).toContain('Do not send an acknowledgement')
    expect(trigger.text).not.toMatch(/I(?:'| a)m here/i)
    expect(lines.some(line => line.includes('[connector] wake service=gmail'))).toBe(true)

    // The same source revision is not a second message.
    const repeat = await runner.poll(T0 + 32 * MIN)
    expect(repeat.action).toBe('silent')
    expect(fired).toHaveLength(1)
    const state = loadConnectorWakeState(store)
    expect(state.wakes).toHaveLength(1)
    expect(state.notified).toHaveLength(2)
  })

  it('indexes without waking when wake is disabled', async () => {
    const { store, index } = setup()
    seedOwnerThread(store)
    const config = {
      google: { services: ['gmail'] },
      wake: { enabled: false, services: ['gmail'] },
    }
    const { runner, fired } = scheduler({ store, index, api: fakeApi([draft()]), config })
    expect((await runner.poll(T0)).action).toBe('backfill')
    const second = await runner.poll(T0 + 16 * MIN)
    expect(second.action).toBe('polled')
    expect(index.stats().count).toBe(1)
    expect(fired).toHaveLength(0)
  })

  it('stays silent when no record clears the usefulness signal', async () => {
    const { store, index } = setup()
    seedOwnerThread(store)
    const { runner, fired } = scheduler({
      store,
      index,
      api: fakeApi([draft({ wake: false, wakeReason: undefined })]),
    })
    expect((await runner.poll(T0)).action).toBe('backfill')
    expect((await runner.poll(T0 + 16 * MIN)).action).toBe('silent')
    expect(fired).toHaveLength(0)
  })

  it('honors the shared quiet-hours window while still indexing', async () => {
    const { store, index } = setup()
    seedOwnerThread(store)
    const quietStart = Date.parse('2026-11-05T23:30:00.000Z')
    const { runner, fired } = scheduler({ store, index, api: fakeApi([draft()]) })
    expect((await runner.poll(quietStart)).action).toBe('backfill')
    const second = await runner.poll(quietStart + 16 * MIN)
    expect(second.action).toBe('quiet-hours')
    expect(second.indexed).toBe(1)
    expect(fired).toHaveLength(0)
  })

  it('rechecks quiet hours after a slow provider fetch', async () => {
    const { store, index } = setup()
    seedOwnerThread(store)
    store.putDoc('connector_wake', 'state', {
      lastCheckAt: T0,
      cursors: { gmail: new Date(T0).toISOString() },
      wakes: [],
      notified: [],
    })
    let now = T0 + 16 * MIN
    const api: GoogleWorkspaceApi = {
      async fetch() {
        now = Date.parse('2026-11-05T23:30:00.000Z')
        return [draft({ updatedAt: new Date(now).toISOString() })]
      },
    }
    const { runner, fired } = scheduler({ store, index, api, now: () => now })
    expect((await runner.poll(T0 + 16 * MIN)).action).toBe('quiet-hours')
    expect(fired).toHaveLength(0)
  })

  it('enforces min-interval and daily caps before firing', async () => {
    const { store, index } = setup()
    seedOwnerThread(store)
    const records = [draft()]
    const { runner, fired } = scheduler({
      store,
      index,
      api: fakeApi(records),
      config: { wake: { minIntervalMinutes: 60 } },
    })
    expect((await runner.poll(T0)).action).toBe('backfill')
    records[0]!.updatedAt = new Date(T0 + MIN).toISOString()
    expect((await runner.poll(T0 + 16 * MIN)).action).toBe('wake')
    records.push(draft({
      externalId: 'message-2',
      title: 'Second invoice',
      occurredAt: new Date(T0 + 10 * MIN).toISOString(),
      updatedAt: new Date(T0 + 10 * MIN).toISOString(),
    }))
    expect((await runner.poll(T0 + 32 * MIN)).action).toBe('min-interval')
    expect(fired).toHaveLength(1)

    const capped = scheduler({
      store,
      index,
      api: fakeApi([draft({ externalId: 'message-3' })]),
      config: { wake: { maxPerDay: 0 } },
    })
    expect((await capped.runner.poll(T0 + 60 * MIN)).action).toBe('daily-cap')
    expect(capped.fired).toHaveLength(0)
  })

  it('respects DROP_SELF and actor allowlists before ingesting', async () => {
    const byActor = setup()
    seedOwnerThread(byActor.store)
    const actorDraft = draft()
    const deniedByActor = scheduler({
      store: byActor.store,
      index: byActor.index,
      api: fakeApi([actorDraft]),
      admission: { actors: ['someone-else'] },
    })
    expect((await deniedByActor.runner.poll(T0)).action).toBe('backfill')
    actorDraft.updatedAt = new Date(T0 + MIN).toISOString()
    expect((await deniedByActor.runner.poll(T0 + 16 * MIN)).action).toBe('admission-denied')
    expect(deniedByActor.fired).toHaveLength(0)

    const bySelf = setup()
    seedOwnerThread(bySelf.store)
    const selfDraft = draft({ externalId: 'message-self' })
    const deniedBySelf = scheduler({
      store: bySelf.store,
      index: bySelf.index,
      api: fakeApi([selfDraft]),
      admission: { dropSelf: ['you'] },
    })
    expect((await deniedBySelf.runner.poll(T0)).action).toBe('backfill')
    selfDraft.updatedAt = new Date(T0 + MIN).toISOString()
    expect((await deniedBySelf.runner.poll(T0 + 16 * MIN)).action).toBe('admission-denied')
    expect(deniedBySelf.fired).toHaveLength(0)

    const byGroup = setup()
    seedOwnerThread(byGroup.store)
    const groupDraft = draft({ externalId: 'message-group' })
    const deniedByGroup = scheduler({
      store: byGroup.store,
      index: byGroup.index,
      api: fakeApi([groupDraft]),
      admission: { groups: ['oc_owner'] },
    })
    expect((await deniedByGroup.runner.poll(T0)).action).toBe('backfill')
    groupDraft.updatedAt = new Date(T0 + MIN).toISOString()
    expect((await deniedByGroup.runner.poll(T0 + 16 * MIN)).action).toBe('admission-denied')
    expect(deniedByGroup.fired).toHaveLength(0)
  })

  it('requires trusted Feishu p2p chat metadata before using a configured chat', async () => {
    for (const chatType of ['group', 'p2p']) {
      const { store, index } = setup()
      const at = new Date(T0 - 60 * MIN).toISOString()
      const trigger: Trigger = {
        id: `trg_feishu_${chatType}`,
        source: 'im',
        threads: [{ source: 'im', id: 'feishu:oc_owner' }],
        actor: { source: 'im', id: 'ou_owner' },
        human: true,
        addressed: 'mention',
        at,
        text: 'synthetic admitted Feishu message',
        channel: {
          source: 'im',
          thread: 'feishu:oc_owner',
          address: { provider: 'feishu', chat_id: 'oc_owner', chat_type: chatType, group: 'oc_owner' },
        },
        meta: {},
      }
      store.putDoc('trigger', trigger.id, trigger)
      store.putDoc('disposition', trigger.id, { at, fanout: [], context: [] } satisfies Disposition)
      const connectorDraft = draft({ externalId: `feishu-${chatType}` })
      const { runner, fired } = scheduler({
        store,
        index,
        api: fakeApi([connectorDraft]),
        config: {
          google: { services: ['gmail'] },
          wake: {
            enabled: true,
            services: ['gmail'],
            source: 'im',
            thread: 'feishu:oc_owner',
            chatId: 'oc_owner',
          },
        },
      })
      expect((await runner.poll(T0)).action).toBe('backfill')
      connectorDraft.updatedAt = new Date(T0 + MIN).toISOString()
      const result = await runner.poll(T0 + 16 * MIN)
      if (chatType === 'group') {
        expect(result.action).toBe('no-target')
        expect(fired).toHaveLength(0)
      } else {
        expect(result.action).toBe('wake')
        expect(fired).toHaveLength(1)
      }
    }
  })

  it('fires only for adapter-built Feishu p2p triggers and rejects adapter-built groups', async () => {
    for (const chatType of ['p2p', 'group', undefined, 'future-chat-kind'] as const) {
      const { store, index } = setup()
      const at = new Date(T0 - 60 * MIN).toISOString()
      const trigger = feishuTriggerFromMessage({
        message_id: `om_adapter_${chatType ?? 'missing'}`,
        chat_id: 'oc_owner',
        ...(chatType === undefined ? {} : { chat_type: chatType }),
        msg_type: 'text',
        content: JSON.stringify({ text: 'hello from Feishu' }),
        create_time: String(Date.parse(at)),
        sender: { id: 'ou_owner', sender_type: 'user' },
      })
      if (chatType === 'p2p') {
        expect(trigger.channel?.address?.chat_type).toBe('p2p')
      } else if (chatType === 'group') {
        expect(trigger.channel?.address?.chat_type).toBe('group')
      } else {
        expect(trigger.channel?.address).not.toHaveProperty('chat_type')
      }
      store.putDoc('trigger', trigger.id, trigger)
      store.putDoc('disposition', trigger.id, { at, fanout: [], context: [] } satisfies Disposition)
      const connectorDraft = draft({ externalId: `adapter-feishu-${chatType}` })
      const { runner, fired } = scheduler({
        store,
        index,
        api: fakeApi([connectorDraft]),
        config: {
          google: { services: ['gmail'] },
          wake: {
            enabled: true,
            services: ['gmail'],
            source: 'im',
            thread: 'feishu:oc_owner',
            chatId: 'oc_owner',
          },
        },
      })
      expect((await runner.poll(T0)).action).toBe('backfill')
      connectorDraft.updatedAt = new Date(T0 + MIN).toISOString()
      const result = await runner.poll(T0 + 16 * MIN)
      if (chatType === 'p2p') {
        expect(result.action).toBe('wake')
        expect(fired).toHaveLength(1)
      } else {
        expect(result.action).toBe('no-target')
        expect(fired).toHaveLength(0)
      }
    }
  })

  it('polls trusted Feishu chat_mode through admission and wake without direct-flag coupling', async () => {
    for (const directMode of [false, true]) {
      const { store, index } = setup()
      const polled = await seedFeishuPollTrigger(store, 'p2p', { visibility: 'private' })
      expect(polled.admitted).toBe(true)
      expect(polled.trigger.channel?.address).toMatchObject({
        provider: 'feishu',
        chat_id: 'oc_owner',
        chat_type: 'p2p',
        group: 'oc_owner',
      })
      expect(polled.trigger.addressed).toBe('mention')

      const event = draft({ externalId: `poll-p2p-${directMode}` })
      const { runner, fired } = scheduler({
        store,
        index,
        api: fakeApi([event]),
        env: directMode ? { DS_AGENT_FEISHU_P2P_DIRECT: '1' } : {},
        config: {
          google: { services: ['gmail'] },
          wake: {
            enabled: true,
            services: ['gmail'],
            source: 'im',
            thread: 'feishu:oc_owner',
            chatId: 'oc_owner',
          },
        },
      })
      expect((await runner.poll(T0)).action).toBe('backfill')
      event.updatedAt = new Date(T0 + MIN).toISOString()
      expect((await runner.poll(T0 + 16 * MIN)).action).toBe('wake')
      expect(fired).toHaveLength(1)
    }

    const noPrivateWake = async (
      mode: string | undefined,
      options: Parameters<typeof seedFeishuPollTrigger>[2] = {},
    ) => {
      const { store, index } = setup()
      const polled = await seedFeishuPollTrigger(store, mode, options)
      const event = draft({ externalId: `poll-${mode ?? 'missing'}-${options.actor ?? 'owner'}` })
      const { runner, fired } = scheduler({
        store,
        index,
        api: fakeApi([event]),
        config: {
          google: { services: ['gmail'] },
          wake: {
            enabled: true,
            services: ['gmail'],
            source: 'im',
            thread: 'feishu:oc_owner',
            chatId: 'oc_owner',
          },
        },
      })
      expect((await runner.poll(T0)).action).toBe('backfill')
      event.updatedAt = new Date(T0 + MIN).toISOString()
      expect((await runner.poll(T0 + 16 * MIN)).action).toBe('no-target')
      expect(fired).toHaveLength(0)
      return polled
    }

    const group = await noPrivateWake('group', { visibility: 'private' })
    expect(group.admitted).toBe(true)
    expect(group.trigger.channel?.address?.chat_type).toBe('group')
    expect(group.trigger.channel?.address?.group).toBe('oc_owner')

    const visibilityOnly = await noPrivateWake(undefined, { visibility: 'private' })
    expect(visibilityOnly.admitted).toBe(true)
    expect(visibilityOnly.trigger.channel?.address).not.toHaveProperty('chat_type')

    const unknown = await noPrivateWake('future-mode', { visibility: 'public' })
    expect(unknown.trigger.channel?.address).not.toHaveProperty('chat_type')

    const failedLookup = await noPrivateWake('p2p', { lookupError: true })
    expect(failedLookup.trigger.channel?.address).not.toHaveProperty('chat_type')

    const actorDenied = await noPrivateWake('p2p', { actor: 'ou_denied' })
    expect(actorDenied.admitted).toBe(false)
    expect(actorDenied.denial).toContain('actor-not-allowlisted')

    const groupDenied = await noPrivateWake('p2p', { allowedGroup: 'oc_other' })
    expect(groupDenied.admitted).toBe(false)
    expect(groupDenied.denial).toContain('group-not-allowlisted')
  })

  it('never invents a recipient when no admitted private thread exists', async () => {
    const { store, index } = setup()
    const { runner, fired, lines } = scheduler({ store, index, api: fakeApi([draft()]) })
    expect((await runner.poll(T0)).action).toBe('backfill')
    expect((await runner.poll(T0 + 16 * MIN)).action).toBe('no-target')
    expect(fired).toHaveLength(0)
    expect(lines.some(line => line.includes('no-private-thread'))).toBe(true)
  })

  it('wakes for a docs event when docs is in the wake set', async () => {
    const { store, index } = setup()
    seedOwnerThread(store)
    const documentDraft = draft({
      service: 'docs',
      kind: 'document',
      externalId: 'doc-1',
      title: 'Shared roadmap',
      wakeReason: 'shared document changed by another person',
    })
    const { runner, fired } = scheduler({ store, index, api: fakeApi([documentDraft]) })
    expect((await runner.poll(T0)).action).toBe('backfill')
    documentDraft.updatedAt = new Date(T0 + MIN).toISOString()
    expect((await runner.poll(T0 + 16 * MIN)).action).toBe('wake')
    expect(fired[0]?.text).toContain('service=docs')
  })

  it('isolates one provider failure and still evaluates the others', async () => {
    const { store, index } = setup()
    seedOwnerThread(store)
    const calendar = draft({
      service: 'calendar',
      kind: 'event',
      externalId: 'event-1',
      title: 'Design review',
      occurredAt: new Date(T0 + 16 * MIN).toISOString(),
      wakeReason: 'calendar event starting soon',
    })
    const { runner, fired } = scheduler({
      store,
      index,
      api: fakeApi([draft(), calendar], ['gmail']),
    })
    const backfill = await runner.poll(T0)
    expect(backfill.action).toBe('backfill')
    expect(backfill.serviceErrors).toHaveLength(1)
    expect(index.stats().count).toBe(1)
    calendar.updatedAt = new Date(T0 + MIN).toISOString()
    expect((await runner.poll(T0 + 16 * MIN)).action).toBe('wake')
    expect(fired[0]?.text).toContain('service=calendar')
  })

  it('keeps failed initial backfill bounds and suppresses historical wake candidates', async () => {
    const { store, index } = setup()
    seedOwnerThread(store)
    const queries: { since: string; until: string }[] = []
    let calls = 0
    const api: GoogleWorkspaceApi = {
      async fetch() { return [] },
      async fetchPage(_service, query) {
        queries.push({ since: query.since, until: query.until })
        calls += 1
        if (calls === 1) throw new Error('synthetic initial provider failure')
        return { drafts: [draft()] }
      },
    }
    const { runner, fired } = scheduler({
      store,
      index,
      api,
      config: { google: { services: ['gmail'] }, wake: { services: ['gmail'] } },
    })
    expect((await runner.poll(T0)).action).toBe('backfill')
    expect(loadConnectorWakeState(store).backfillPending).toBe(true)
    expect((await runner.poll(T0 + MIN)).action).toBe('not-due')
    expect(queries).toHaveLength(1)
    expect((await runner.poll(T0 + 16 * MIN)).action).toBe('backfill')
    expect(queries[1]).toEqual(queries[0])
    expect(loadConnectorWakeState(store).backfillPending).toBeUndefined()
    expect((await runner.poll(T0 + 32 * MIN)).action).toBe('silent')
    expect(fired).toHaveLength(0)
    expect(loadConnectorWakeState(store).notified).toHaveLength(1)
  })

  it('retires an expired Calendar starting-soon wake during replay, including legacy pending rows', async () => {
    const { store, index } = setup()
    seedOwnerThread(store)
    const event = draft({
      service: 'calendar',
      kind: 'event',
      externalId: 'expired-meeting',
      occurredAt: new Date(T0 + 30 * MIN).toISOString(),
      wakeReason: 'calendar event starting soon',
    })
    const record = index.upsert([event]).records[0]!
    const trigger = connectorTrigger(record, {
      channel: { source: 'cli', thread: 'local' },
      actor: { source: 'cli', id: 'you' },
    }, T0)
    const pending: ConnectorPendingWake = {
      at: T0,
      calendarProvenance: {
        version: 1,
        occurredAt: record.occurredAt,
        updatedAt: record.updatedAt,
        kind: 'event',
        wakeReason: record.wakeReason,
      },
      trigger,
      recordId: record.id,
      service: 'calendar',
    }
    store.putDoc('connector_wake', 'state', {
      lastCheckAt: T0,
      cursors: { calendar: new Date(T0).toISOString() },
      pending: [pending],
      wakes: [],
      notified: [],
    })
    const { runner, fired } = scheduler({
      store,
      index,
      api: fakeApi([]),
      config: {
        google: { services: ['calendar'] },
        wake: { enabled: true, services: ['calendar'], calendarLookaheadMinutes: 60 },
      },
    })

    await runner.poll(T0 + 2 * 60 * MIN)
    const state = loadConnectorWakeState(store)
    expect(state.pending).toBeUndefined()
    expect(state.notified.some(row => row.triggerId === trigger.id)).toBe(true)
    expect(state.wakes).toHaveLength(0)
    expect(state.lastWakeAt).toBeUndefined()
    expect(fired).toHaveLength(0)
  })

  it('replays a Calendar pending wake while its eligibility window is still open', async () => {
    const { store, index } = setup()
    seedOwnerThread(store)
    const record = index.upsert([draft({
      service: 'calendar', kind: 'event', externalId: 'still-imminent',
      occurredAt: new Date(T0 + 30 * MIN).toISOString(),
      wakeReason: 'calendar event starting soon',
    })]).records[0]!
    const trigger = connectorTrigger(record, {
      channel: { source: 'cli', thread: 'local' },
      actor: { source: 'cli', id: 'you' },
    }, T0)
    store.putDoc('connector_wake', 'state', {
      lastCheckAt: T0,
      cursors: { calendar: new Date(T0).toISOString() },
      pending: [{
        at: T0,
        calendarProvenance: {
          version: 1,
          occurredAt: record.occurredAt,
          updatedAt: record.updatedAt,
          kind: 'event',
          wakeReason: record.wakeReason,
        },
        trigger,
        recordId: record.id,
        service: 'calendar',
      }],
      wakes: [],
      notified: [],
    })
    const { runner, fired } = scheduler({
      store, index, api: fakeApi([]),
      config: {
        google: { services: ['calendar'] },
        wake: { enabled: true, services: ['calendar'], calendarLookaheadMinutes: 60 },
      },
    })
    ;(runner as unknown as { opts: { fire: (trigger: Trigger) => void } }).opts.fire = next => {
      fired.push(next)
      throw new Error('temporary ingress failure')
    }

    await runner.poll(T0 + 45 * MIN)
    expect(fired.map(row => row.id)).toContain(trigger.id)
    expect(loadConnectorWakeState(store).pending).toHaveLength(1)
  })

  it('keeps an ingress failure in the durable pending wake outbox', async () => {
    const { store, index } = setup()
    seedOwnerThread(store)
    store.putDoc('connector_wake', 'state', {
      lastCheckAt: T0,
      cursors: {
        gmail: new Date(T0).toISOString(),
        calendar: new Date(T0).toISOString(),
        docs: new Date(T0).toISOString(),
      },
      wakes: [],
      notified: [],
    })
    const { runner } = scheduler({ store, index, api: fakeApi([draft()]) })
    const originalFire = (runner as unknown as { opts: { fire: (trigger: Trigger) => void } }).opts.fire
    ;(runner as unknown as { opts: { fire: (trigger: Trigger) => void } }).opts.fire = () => {
      throw new Error('ingress unavailable')
    }

    await expect(runner.poll(T0 + 16 * MIN)).resolves.toMatchObject({ action: 'wake' })
    expect(loadConnectorWakeState(store).pending).toHaveLength(1)
    expect(loadConnectorWakeState(store).notified).toHaveLength(0)

    ;(runner as unknown as { opts: { fire: (trigger: Trigger) => void } }).opts.fire = originalFire
  })

  it('holds incomplete pending wakes when authorization is revoked, but finishes durable ingress bookkeeping', async () => {
    const cases: {
      name: string
      wake: Record<string, unknown>
      quiet?: { quietStart: string; quietEnd: string; timezone: string }
      admission?: { actors?: string[]; groups?: string[] }
      reason?: string
    }[] = [
      { name: 'disabled', wake: { enabled: false }, reason: 'wake-disabled' },
      {
        name: 'quiet-hours',
        wake: {},
        quiet: { quietStart: '10:00', quietEnd: '11:00', timezone: 'UTC' },
        reason: 'quiet-hours',
      },
      {
        name: 'actor-revoked',
        wake: {},
        admission: { actors: ['another-owner'] },
        reason: 'actor-not-allowlisted',
      },
      {
        name: 'group-revoked',
        wake: {},
        admission: { groups: ['another-group'] },
        reason: 'group-not-allowlisted',
      },
    ]
    for (const entry of cases) {
      const { store, index } = setup()
      seedOwnerThread(store)
      const pending = pendingWake(index, T0, entry.name)
      store.putDoc('connector_wake', 'state', {
        lastCheckAt: T0,
        cursors: { gmail: new Date(T0).toISOString() },
        pending: [pending],
        wakes: [],
        notified: [],
      })
      const { runner, lines } = scheduler({
        store,
        index,
        api: fakeApi([]),
        config: {
          google: { services: ['gmail'] },
          wake: { enabled: true, services: ['gmail'], source: 'cli', thread: 'local', ...entry.wake },
        },
        ...(entry.admission ? { admission: entry.admission } : {}),
        ...(entry.quiet ? { quiet: entry.quiet } : {}),
      })
      let fires = 0
      ;(runner as unknown as { opts: { fire: (trigger: Trigger) => void } }).opts.fire = () => { fires += 1 }
      const result = await runner.poll(T0 + 16 * MIN)
      expect(result.action).toBe('wake')
      expect(fires).toBe(0)
      expect(loadConnectorWakeState(store).pending).toHaveLength(1)
      expect(loadConnectorWakeState(store).wakes).toHaveLength(0)
      expect(loadConnectorWakeState(store).notified).toHaveLength(0)
      expect(lines.some(line => line.includes(`reason=${entry.reason}`))).toBe(true)
    }

    const { store, index } = setup()
    seedOwnerThread(store)
    const pending = pendingWake(index, T0, 'already-complete')
    const completedAt = new Date(T0 + 17 * MIN).toISOString()
    store.putDoc('trigger', pending.trigger.id, pending.trigger)
    store.putDoc('disposition', pending.trigger.id, {
      at: completedAt,
      fanout: [],
      context: [],
    } satisfies Disposition)
    store.putDoc('connector_wake', 'state', {
      lastCheckAt: T0,
      cursors: { gmail: new Date(T0).toISOString() },
      pending: [pending],
      wakes: [],
      notified: [],
    })
    const { runner } = scheduler({
      store,
      index,
      api: fakeApi([]),
      config: {
        google: { services: ['gmail'] },
        wake: { enabled: false, services: ['gmail'], source: 'cli', thread: 'local' },
      },
    })
    await runner.poll(T0 + 16 * MIN)
    const state = loadConnectorWakeState(store)
    expect(state.pending ?? []).toHaveLength(0)
    expect(state.lastWakeAt).toBe(Date.parse(completedAt))
    expect(state.wakes[0]?.at).toBe(Date.parse(completedAt))
    expect(state.notified[0]?.at).toBe(Date.parse(completedAt))
  })

  it('retires incomplete pending wakes when their private target changes or is revoked', async () => {
    for (const targetState of ['changed', 'revoked'] as const) {
      const { store, index } = setup()
      seedOwnerThread(store)
      const pending = pendingWake(index, T0, `stale-target-${targetState}`)
      if (targetState === 'changed') {
        const replacement: Trigger = {
          id: 'trg_cli_replacement_owner',
          source: 'cli',
          threads: [{ source: 'cli', id: 'local' }],
          actor: { source: 'cli', id: 'replacement-owner' },
          human: true,
          addressed: 'direct',
          at: new Date(T0 + MIN).toISOString(),
          text: 'replacement owner',
          channel: { source: 'cli', thread: 'local' },
          meta: {},
        }
        store.putDoc('trigger', replacement.id, replacement)
        store.putDoc('disposition', replacement.id, {
          at: replacement.at,
          fanout: [],
          context: [],
        } satisfies Disposition)
      }
      store.putDoc('connector_wake', 'state', {
        lastCheckAt: T0,
        cursors: { gmail: new Date(T0).toISOString() },
        pending: [pending],
        wakes: [],
        notified: [],
      })
      const candidate = draft({
        externalId: `after-stale-target-${targetState}`,
        occurredAt: new Date(T0 + 16 * MIN).toISOString(),
        updatedAt: new Date(T0 + 17 * MIN).toISOString(),
      })
      const targetConfig = targetState === 'revoked'
        ? { source: 'cli', thread: 'revoked-thread' }
        : { source: 'cli', thread: 'local' }
      const first = scheduler({
        store,
        index,
        api: fakeApi([candidate]),
        config: {
          google: { services: ['gmail'] },
          wake: { enabled: true, services: ['gmail'], ...targetConfig },
        },
      })
      const result = await first.runner.poll(T0 + 16 * MIN)
      expect(result.action).toBe(targetState === 'changed' ? 'wake' : 'no-target')
      expect(first.fired.some(trigger => trigger.id === pending.trigger.id)).toBe(false)
      let state = loadConnectorWakeState(store)
      expect(state.pending ?? []).toHaveLength(0)
      expect(state.notified.some(row => row.triggerId === pending.trigger.id)).toBe(true)
      expect(state.cursors?.gmail).toBe(new Date(T0 + 16 * MIN).toISOString())

      if (targetState === 'changed') {
        expect(first.fired).toHaveLength(1)
        expect(first.fired[0]?.id).not.toBe(pending.trigger.id)
      } else {
        // Once the owner target is available again, a later eligible revision
        // can wake; the revoked pending row no longer starves the pipeline.
        const restored = scheduler({
          store,
          index,
          api: fakeApi([candidate]),
          config: {
            google: { services: ['gmail'] },
            wake: { enabled: true, services: ['gmail'], source: 'cli', thread: 'local' },
          },
        })
        expect((await restored.runner.poll(T0 + 32 * MIN)).action).toBe('wake')
        expect(restored.fired).toHaveLength(1)
        expect(restored.fired[0]?.id).not.toBe(pending.trigger.id)
        state = loadConnectorWakeState(store)
        expect(state.cursors?.gmail).toBe(new Date(T0 + 32 * MIN).toISOString())
        expect(state.pending ?? []).toHaveLength(0)
      }
    }
  })

  it('rechecks min-interval and daily caps before replaying incomplete pending wakes', async () => {
    for (const policy of ['min-interval', 'daily-cap'] as const) {
      const { store, index } = setup()
      seedOwnerThread(store)
      const pending = pendingWake(index, T0, `replay-${policy}`)
      const priorAt = T0 + 10 * MIN
      store.putDoc('connector_wake', 'state', {
        lastCheckAt: T0,
        ...(policy === 'min-interval' ? { lastWakeAt: priorAt } : {}),
        cursors: { gmail: new Date(T0).toISOString() },
        pending: [pending],
        wakes: policy === 'daily-cap' ? [{
          at: priorAt,
          triggerId: 'trg_prior_wake',
          recordId: 'record_prior_wake',
          service: 'gmail',
        }] : [],
        notified: [],
      })
      const { runner, fired, lines } = scheduler({
        store,
        index,
        api: fakeApi([]),
        config: {
          google: { services: ['gmail'] },
          wake: {
            enabled: true,
            services: ['gmail'],
            source: 'cli',
            thread: 'local',
            minIntervalMinutes: 15,
            maxPerDay: policy === 'daily-cap' ? 1 : 3,
          },
        },
      })
      ;(runner as unknown as { opts: { fire: (trigger: Trigger) => void } }).opts.fire = trigger => {
        fired.push(trigger)
      }
      expect((await runner.poll(T0 + 16 * MIN)).action).toBe('wake')
      expect(fired).toHaveLength(0)
      expect(loadConnectorWakeState(store).pending).toHaveLength(1)
      expect(loadConnectorWakeState(store).cursors?.gmail).toBe(new Date(T0 + 16 * MIN).toISOString())
      expect(lines.some(line => line.includes(`reason=${policy}`))).toBe(true)
    }
  })

  it('uses ingress completion time for caps and min-interval after cross-day replay', async () => {
    const monday = Date.parse('2026-11-09T10:00:00.000Z')
    const tuesday = Date.parse('2026-11-10T10:00:00.000Z')
    for (const { wakeConfig, expected } of [
      { wakeConfig: { maxPerDay: 1, minIntervalMinutes: 15 }, expected: 'daily-cap' },
      { wakeConfig: { maxPerDay: 3, minIntervalMinutes: 60 }, expected: 'min-interval' },
    ]) {
      const { store, index } = setup()
      seedOwnerThread(store)
      const pending = pendingWake(index, monday, `cross-day-${expected}`)
      store.putDoc('trigger', pending.trigger.id, pending.trigger)
      store.putDoc('disposition', pending.trigger.id, {
        at: new Date(tuesday).toISOString(),
        fanout: [],
        context: [],
      } satisfies Disposition)
      store.putDoc('connector_wake', 'state', {
        lastCheckAt: tuesday - 20 * MIN,
        cursors: { gmail: new Date(tuesday - 20 * MIN).toISOString() },
        pending: [pending],
        wakes: [],
        notified: [],
      })
      const candidate = draft({
        externalId: `tuesday-candidate-${expected}`,
        occurredAt: new Date(tuesday).toISOString(),
        updatedAt: new Date(tuesday + MIN).toISOString(),
      })
      const { runner, fired } = scheduler({
        store,
        index,
        api: fakeApi([candidate]),
        now: () => tuesday + 20 * MIN,
        config: {
          google: { services: ['gmail'] },
          wake: {
            enabled: true,
            services: ['gmail'],
            source: 'cli',
            thread: 'local',
            ...wakeConfig,
          },
        },
      })
      expect((await runner.poll(tuesday + 20 * MIN)).action).toBe(expected)
      expect(fired).toHaveLength(0)
      const state = loadConnectorWakeState(store)
      expect(state.lastWakeAt).toBe(tuesday)
      expect(state.wakes[0]?.at).toBe(tuesday)
      expect(state.notified[0]?.at).toBe(tuesday)
    }
  })

  it('isolates legacy Calendar pending wakes when their source provenance was evicted', async () => {
    const { home, store: firstStore, index: firstIndex } = setup()
    seedOwnerThread(firstStore)
    const record = firstIndex.upsert([draft({
      service: 'calendar',
      kind: 'event',
      externalId: 'evicted-calendar-source',
      occurredAt: new Date(T0 - 30 * MIN).toISOString(),
      wakeReason: 'calendar event starting soon',
    })]).records[0]!
    const trigger = connectorTrigger(record, {
      channel: { source: 'cli', thread: 'local' },
      actor: { source: 'cli', id: 'you' },
    }, T0)
    const legacyPending: ConnectorPendingWake = {
      at: T0,
      trigger,
      recordId: record.id,
      service: 'calendar',
    }
    firstStore.putDoc('connector_wake', 'state', {
      lastCheckAt: T0,
      cursors: { calendar: new Date(T0).toISOString() },
      pending: [legacyPending],
      wakes: [],
      notified: [],
    })
    firstIndex.prune({ maxRecords: 0, maxAgeDays: 0 })
    firstStore.close()
    const store = new Store(home)
    stores.push(store)
    const index = new ConnectorIndex(store, { redact: text => text, now: () => new Date(T0) })
    const { runner, fired } = scheduler({
      store, index, api: fakeApi([]),
      config: {
        google: { services: ['calendar'] },
        wake: { enabled: true, services: ['calendar'], calendarLookaheadMinutes: 60 },
      },
    })

    await runner.poll(T0 + 2 * 60 * MIN)
    const raw = store.getDoc<Record<string, unknown>>('connector_wake', 'state')
    expect(fired).toHaveLength(0)
    expect(raw?.uncertain).toHaveLength(1)
    expect(raw?.pending).toHaveLength(0)
    expect(raw?.notified).toHaveLength(0)
    expect(raw?.wakes).toHaveLength(0)
  })

  it('uses immutable Calendar pending provenance across index mutation and the inclusive grace boundary', async () => {
    for (const [label, replayOffset, shouldFire] of [
      ['inclusive boundary', 15 * MIN, true],
      ['just after boundary', 15 * MIN + 1, false],
    ] as const) {
      const { store, index } = setup()
      seedOwnerThread(store)
      const record = index.upsert([draft({
        service: 'calendar',
        kind: 'event',
        externalId: `calendar-${label}`,
        occurredAt: new Date(T0).toISOString(),
        wakeReason: 'calendar event starting soon',
      })]).records[0]!
      const trigger = connectorTrigger(record, {
        channel: { source: 'cli', thread: 'local' },
        actor: { source: 'cli', id: 'you' },
      }, T0)
      const pending: ConnectorPendingWake = {
        at: T0,
        calendarProvenance: {
          version: 1,
          occurredAt: new Date(T0).toISOString(),
          updatedAt: new Date(T0 - 5 * MIN).toISOString(),
          kind: 'event',
          wakeReason: 'calendar event starting soon',
        },
        trigger,
        recordId: record.id,
        service: 'calendar',
      }
      store.putDoc('connector_wake', 'state', {
        lastCheckAt: T0,
        cursors: { calendar: new Date(T0).toISOString() },
        pending: [pending],
        wakes: [],
        notified: [],
      })
      index.upsert([draft({
        service: 'calendar',
        kind: 'event',
        externalId: `calendar-${label}`,
        occurredAt: new Date(T0 + 90 * MIN).toISOString(),
        updatedAt: new Date(T0 + 90 * MIN).toISOString(),
        wakeReason: 'calendar event starting soon',
      })])
      const { runner, fired } = scheduler({
        store, index, api: fakeApi([]),
        config: {
          google: { services: ['calendar'] },
          wake: { enabled: true, services: ['calendar'], calendarLookaheadMinutes: 120 },
        },
      })

      await runner.poll(T0 + replayOffset)
      expect(fired).toHaveLength(shouldFire ? 1 : 0)
      if (!shouldFire) {
        const raw = store.getDoc<Record<string, unknown>>('connector_wake', 'state')
        expect(raw?.pending).toHaveLength(0)
        expect(raw?.wakes).toHaveLength(0)
      }
    }
  })

  it('continues provider indexing and checkpoints while pending fire keeps failing', async () => {
    const { store, index } = setup()
    seedOwnerThread(store)
    const pending = pendingWake(index, T0, 'stuck-index')
    store.putDoc('connector_wake', 'state', {
      lastCheckAt: T0,
      cursors: { gmail: new Date(T0).toISOString() },
      pending: [pending],
      wakes: [],
      notified: [],
    })
    const page = draft({ wake: false, wakeReason: undefined, externalId: 'indexed-while-pending' })
    const { runner } = scheduler({
      store,
      index,
      api: fakeApi([page]),
      config: {
        google: { services: ['gmail'] },
        wake: { enabled: true, services: ['gmail'] },
      },
    })
    let fires = 0
    ;(runner as unknown as { opts: { fire: (trigger: Trigger) => void } }).opts.fire = () => {
      fires += 1
      throw new Error('ingress still unavailable')
    }
    expect((await runner.poll(T0 + 16 * MIN)).action).toBe('wake')
    expect(index.query({ limit: 20 }).some(record => record.externalId === 'indexed-while-pending')).toBe(true)
    expect(loadConnectorWakeState(store).cursors?.gmail).toBe(new Date(T0 + 16 * MIN).toISOString())
    expect(loadConnectorWakeState(store).pending).toHaveLength(1)
    expect((await runner.poll(T0 + 32 * MIN)).action).toBe('wake')
    expect(fires).toBe(2)
    expect(loadConnectorWakeState(store).cursors?.gmail).toBe(new Date(T0 + 32 * MIN).toISOString())
    expect(loadConnectorWakeState(store).pending).toHaveLength(1)
  })

  it('resumes a persisted page token within the record bound without advancing the time cursor', async () => {
    const { store, index } = setup()
    const pages: { pageToken?: string; since: string; until: string; ids: string[] }[] = []
    const api: GoogleWorkspaceApi = {
      async fetch() { return [] },
      async fetchPage(_service, query) {
        pages.push({ pageToken: query.pageToken, since: query.since, until: query.until, ids: [] })
        const pageNumber = query.pageToken ? 2 : 1
        const ids = pageNumber === 1 ? ['old-1'] : ['old-2']
        pages.at(-1)!.ids = ids
        return {
          drafts: ids.map(id => draft({ externalId: id, occurredAt: new Date(T0 - 10 * MIN).toISOString() })),
          ...(pageNumber === 1 ? { nextPageToken: 'page-2' } : {}),
        }
      },
    }
    const { runner } = scheduler({
      store, index, api,
      config: {
        google: { services: ['gmail'] },
        poll: { intervalMinutes: 15, maxRecordsPerPoll: 1 },
        wake: { enabled: false, services: ['gmail'] },
      },
    })

    expect((await runner.poll(T0)).action).toBe('backfill')
    expect(index.stats().count).toBe(1)
    expect(loadConnectorWakeState(store).cursors?.gmail).toBeUndefined()
    expect(loadConnectorWakeState(store).pageTokens?.gmail).toBe('page-2')
    expect((await runner.poll(T0 + 16 * MIN)).action).toBe('backfill')
    expect(pages[1]?.pageToken).toBe('page-2')
    expect(pages[1]?.since).toBe(pages[0]?.since)
    expect(pages[1]?.until).toBe(pages[0]?.until)
    expect(index.stats().count).toBe(2)
    expect(loadConnectorWakeState(store).cursors?.gmail).toBe(new Date(T0).toISOString())
    expect(loadConnectorWakeState(store).pageTokens?.gmail).toBeUndefined()
    expect(index.query({ limit: 10 }).map(record => record.externalId).sort()).toEqual(['old-1', 'old-2'])
  })

  it('clears invalid provider page tokens durably and retries the saved query after restart', async () => {
    const { store, index } = setup()
    const originalQuery = {
      since: new Date(T0 - 2 * 60 * MIN).toISOString(),
      until: new Date(T0 - MIN).toISOString(),
    }
    store.putDoc('connector_wake', 'state', {
      lastCheckAt: T0,
      cursors: { docs: new Date(T0 - 3 * MIN).toISOString() },
      pageTokens: { docs: 'expired-page-token' },
      pageQueries: { docs: originalQuery },
      wakes: [],
      notified: [],
    })
    const queries: { pageToken?: string; since: string; until: string }[] = []
    const api: GoogleWorkspaceApi = {
      async fetch() { return [] },
      async fetchPage(_service, query) {
        queries.push({ pageToken: query.pageToken, since: query.since, until: query.until })
        if (query.pageToken === 'expired-page-token') throw new GoogleInvalidPageTokenError('/drive/v3/files')
        if (!query.pageToken) return {
          drafts: [draft({ service: 'docs', kind: 'document', externalId: 'restart-data', updatedAt: originalQuery.until })],
          nextPageToken: 'fresh-page-token',
        }
        return { drafts: [draft({ service: 'docs', kind: 'document', externalId: 'fresh-continuation-data', updatedAt: originalQuery.until })] }
      },
    }
    const config = {
      google: { services: ['docs'] },
      wake: { enabled: false, services: ['docs'] },
    }
    const first = scheduler({ store, index, api, config })
    await first.runner.poll(T0 + 16 * MIN)
    expect(queries[0]).toEqual({ pageToken: 'expired-page-token', ...originalQuery })
    expect(loadConnectorWakeState(store).pageTokens?.docs).toBeUndefined()
    expect(loadConnectorWakeState(store).pageQueries?.docs).toEqual(originalQuery)

    const restarted = scheduler({ store, index, api, config })
    await restarted.runner.poll(T0 + 32 * MIN)
    expect(queries[1]).toEqual({ ...originalQuery })
    expect(index.query({ service: 'docs', kind: 'document', limit: 20 }).some(record => record.externalId === 'restart-data')).toBe(true)
    expect(index.query({ service: 'gmail', limit: 20 }).some(record => record.externalId === 'restart-data')).toBe(false)
    expect(loadConnectorWakeState(store).pageTokens?.docs).toBe('fresh-page-token')
    expect(loadConnectorWakeState(store).cursors?.docs).toBe(new Date(T0 - 3 * MIN).toISOString())

    await restarted.runner.poll(T0 + 48 * MIN)
    expect(queries[2]).toEqual({ pageToken: 'fresh-page-token', ...originalQuery })
    expect(index.query({ service: 'docs', kind: 'document', limit: 20 }).some(record => record.externalId === 'fresh-continuation-data')).toBe(true)
    expect(index.query({ service: 'gmail', limit: 20 }).some(record => record.externalId === 'fresh-continuation-data')).toBe(false)
    expect(loadConnectorWakeState(store).pageTokens?.docs).toBeUndefined()
    expect(loadConnectorWakeState(store).cursors?.docs).toBe(originalQuery.until)
  })

  it('backs off repeated rejection of the same provider continuation token', async () => {
    const { store, index } = setup()
    const bounds = {
      since: new Date(T0 - 2 * 60 * MIN).toISOString(),
      until: new Date(T0 - MIN).toISOString(),
    }
    store.putDoc('connector_wake', 'state', {
      lastCheckAt: T0,
      cursors: { docs: bounds.until },
      pageTokens: { docs: 'bad-token' },
      pageQueries: { docs: bounds },
      wakes: [],
      notified: [],
    })
    let calls = 0
    const api: GoogleWorkspaceApi = {
      async fetch() { return [] },
      async fetchPage(_service, query) {
        calls += 1
        if (query.pageToken === 'bad-token') throw new GoogleInvalidPageTokenError('/drive/v3/files')
        return { drafts: [], nextPageToken: 'bad-token' }
      },
    }
    const { runner, lines } = scheduler({
      store,
      index,
      api,
      config: { google: { services: ['docs'] }, wake: { enabled: false, services: ['docs'] } },
    })
    await runner.poll(T0 + 16 * MIN)
    await runner.poll(T0 + 32 * MIN)
    await runner.poll(T0 + 48 * MIN)
    const state = loadConnectorWakeState(store)
    expect(state.invalidPageTokens?.docs).toBe('bad-token')
    expect(state.invalidTokenRetries?.docs).toBe(2)
    expect(state.invalidTokenRetryAfter?.docs).toBeGreaterThan(T0 + 64 * MIN)
    expect((await runner.poll(T0 + 64 * MIN)).action).toBe('polled')
    expect(calls).toBe(3)
    expect(lines.some(line => line.includes('page-token retry deferred service=docs'))).toBe(true)
  })

  it('retains provider page tokens after transient errors', async () => {
    const { store, index } = setup()
    const bounds = {
      since: new Date(T0 - 2 * 60 * MIN).toISOString(),
      until: new Date(T0 - MIN).toISOString(),
    }
    store.putDoc('connector_wake', 'state', {
      lastCheckAt: T0,
      cursors: { docs: bounds.until },
      pageTokens: { docs: 'retry-after-network-error' },
      pageQueries: { docs: bounds },
      wakes: [],
      notified: [],
    })
    const api: GoogleWorkspaceApi = {
      async fetch() { return [] },
      async fetchPage() { throw new Error('network timeout') },
    }
    const { runner } = scheduler({
      store,
      index,
      api,
      config: {
        google: { services: ['docs'] },
        wake: { enabled: false, services: ['docs'] },
      },
    })
    await runner.poll(T0 + 16 * MIN)
    expect(loadConnectorWakeState(store).pageTokens?.docs).toBe('retry-after-network-error')
    expect(loadConnectorWakeState(store).pageQueries?.docs).toEqual(bounds)
  })

  it('replays an outbox wake after restart when the crash precedes ingress persistence', async () => {
    const { store, index } = setup()
    seedOwnerThread(store)
    store.putDoc('connector_wake', 'state', {
      lastCheckAt: T0,
      cursors: {
        gmail: new Date(T0).toISOString(),
        calendar: new Date(T0).toISOString(),
        docs: new Date(T0).toISOString(),
      },
      wakes: [],
      notified: [],
    })
    const first = scheduler({ store, index, api: fakeApi([draft()]) })
    ;(first.runner as unknown as { opts: { fire: (trigger: Trigger) => void } }).opts.fire = () => {
      throw new Error('simulated crash before ingress commit')
    }
    const result = await first.runner.poll(T0 + 16 * MIN)
    expect(result.action).toBe('wake')
    expect(loadConnectorWakeState(store).pending).toHaveLength(1)
    expect(loadConnectorWakeState(store).notified).toHaveLength(0)
    expect(store.listDocs<Trigger>('trigger').filter(trigger => trigger.id.startsWith(CONNECTOR_TRIGGER_PREFIX))).toHaveLength(0)

    const restarted = scheduler({ store, index, api: fakeApi([draft()]) })
    const replay = await restarted.runner.poll(T0 + 32 * MIN)
    expect(replay.action).toBe('silent')
    expect(restarted.fired).toHaveLength(1)
    expect(loadConnectorWakeState(store).pending ?? []).toHaveLength(0)
    expect(loadConnectorWakeState(store).notified).toHaveLength(1)
    expect(store.listDocs<Trigger>('trigger').filter(trigger => trigger.id.startsWith(CONNECTOR_TRIGGER_PREFIX))).toHaveLength(1)
  })

  it('keeps a trigger-only ingress pending and resumes until disposition is durable', async () => {
    const { store, index } = setup()
    seedOwnerThread(store)
    store.putDoc('connector_wake', 'state', {
      lastCheckAt: T0,
      cursors: {
        gmail: new Date(T0).toISOString(),
        calendar: new Date(T0).toISOString(),
        docs: new Date(T0).toISOString(),
      },
      wakes: [],
      notified: [],
    })
    const first = scheduler({ store, index, api: fakeApi([draft()]) })
    let attempts = 0
    ;(first.runner as unknown as { opts: { fire: (trigger: Trigger) => void } }).opts.fire = trigger => {
      attempts += 1
      store.putDoc('trigger', trigger.id, trigger)
      if (attempts === 1) throw new Error('simulated crash after trigger row only')
      store.putDoc('disposition', trigger.id, {
        at: trigger.at,
        fanout: [],
        context: [],
      } satisfies Disposition)
    }
    await first.runner.poll(T0 + 16 * MIN)
    expect(loadConnectorWakeState(store).pending).toHaveLength(1)
    const firstTrigger = store.listDocs<Trigger>('trigger')
      .find(trigger => trigger.id.startsWith(CONNECTOR_TRIGGER_PREFIX))!
    expect(store.getDoc<Disposition>('disposition', firstTrigger.id)).toBeUndefined()

    const restarted = scheduler({ store, index, api: fakeApi([draft()]) })
    ;(restarted.runner as unknown as { opts: { fire: (trigger: Trigger) => void } }).opts.fire = trigger => {
      attempts += 1
      store.putDoc('trigger', trigger.id, trigger)
      store.putDoc('disposition', trigger.id, {
        at: trigger.at,
        fanout: [],
        context: [],
      } satisfies Disposition)
    }
    await restarted.runner.poll(T0 + 32 * MIN)
    expect(attempts).toBe(2)
    expect(loadConnectorWakeState(store).pending ?? []).toHaveLength(0)
    expect(loadConnectorWakeState(store).notified).toHaveLength(1)
    expect(store.listDocs<Trigger>('trigger').filter(trigger => trigger.id.startsWith(CONNECTOR_TRIGGER_PREFIX))).toHaveLength(1)
    expect(store.getDoc<Disposition>('disposition', firstTrigger.id)).toBeDefined()
  })

  it('marks connector wakes as messaging envelopes', () => {
    const ticket = {
      id: 'ticket_1',
      originTriggerId: 'trg_connector_1',
      inputs: [{ id: 'input_1', kind: 'trigger', triggerId: 'trg_connector_1' }],
      channels: [{
        source: 'cli',
        thread: 'local',
        address: { connector: '1' },
      }],
    } as unknown as Parameters<typeof isConnectorWakeTicket>[0]
    expect(isConnectorWakeTicket(ticket)).toBe(true)
    expect(isConnectorWakeTicket({
      ...ticket,
      inputs: [
        ...ticket.inputs,
        { id: 'input_2', kind: 'trigger', triggerId: 'trg_ordinary', at: new Date(T0).toISOString() },
      ],
      channels: [
        ...ticket.channels,
        { source: 'cli', thread: 'other' },
      ],
    })).toBe(false)
    expect(isConnectorWakeTicket({
      ...ticket,
      channels: [{ source: 'cli', thread: 'local' }],
    })).toBe(false)
  })

  it('suppresses the canned ack and tells the Router to stay silent by default', () => {
    const { home, store } = setup()
    const lines: string[] = []
    const host: Host = {
      repo: store,
      now: () => new Date(T0).toISOString(),
      metrics: new Metrics(home),
      log: line => { lines.push(line) },
      scope: { admit: () => ({ listened: true, reason: 'test' }) },
    }
    const ticket = {
      id: 'ticket_connector',
      title: 'Invoice for November',
      brief: 'CONNECTOR_EVENT\nservice=gmail',
      originTriggerId: 'trg_connector_gmail_x_y',
      speculative: false,
      inputs: [{ id: 'input_1', kind: 'trigger', triggerId: 'trg_connector_gmail_x_y' }],
      channels: [{ source: 'cli', thread: 'local', address: { connector: '1' } }],
    } as unknown as Ticket
    new Replies(host).acknowledge(ticket)
    expect(store.listReplies()).toEqual([])
    expect(lines.some(line => line.includes('ack-suppressed') && line.includes('channel=connector'))).toBe(true)

    const mixed = {
      ...ticket,
      inputs: [
        ...ticket.inputs,
        { id: 'input_2', kind: 'trigger', triggerId: 'trg_ordinary', at: new Date(T0).toISOString() },
      ],
      channels: [
        ...ticket.channels,
        { source: 'im', thread: 'topic/ordinary' },
      ],
    } as Ticket
    expect(isConnectorWakeTicket(mixed)).toBe(false)
    new Replies(host).acknowledge(mixed)
    expect(store.listReplies()).toHaveLength(1)

    const prompt = routerPromptFor(ticket)
    expect(prompt).toContain('connector=true')
    expect(prompt).toContain('message=CONNECTOR_EVENT')
    expect(prompt).toContain('Do not send an acknowledgement')
    expect(prompt).toContain('call assess_trigger kind=stop')
  })
})

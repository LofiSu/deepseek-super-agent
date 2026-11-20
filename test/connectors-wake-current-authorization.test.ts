import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeProactiveConfig } from '../src/harness/proactive.ts'
import { ConnectorWakeScheduler, connectorTrigger, loadConnectorWakeState, type ConnectorPendingWake } from '../src/connectors/wake.ts'
import { normalizeConnectorConfig } from '../src/connectors/config.ts'
import { ConnectorIndex } from '../src/connectors/index-store.ts'
import type { GoogleWorkspaceApi } from '../src/connectors/google.ts'
import type { ConnectorDraft } from '../src/connectors/types.ts'
import type { Disposition, Trigger } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'

const homes: string[] = []
const stores: Store[] = []
const T0 = Date.parse('2026-11-05T10:00:00.000Z')
const MIN = 60_000
const TARGET_ID = 'trg_old_private_owner'

function setup(): { store: Store; index: ConnectorIndex } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-wake-current-auth-'))
  homes.push(home)
  const store = new Store(home)
  stores.push(store)
  return { store, index: new ConnectorIndex(store, { redact: value => value, now: () => new Date(T0) }) }
}

afterEach(() => {
  for (const store of stores.splice(0)) if (store.isOpen) store.close()
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function seedOwner(store: Store, input: { id: string; source: string; thread: string; actor: string; address?: Record<string, string> }): Trigger {
  const at = new Date(T0 - MIN).toISOString()
  const trigger: Trigger = {
    id: input.id,
    source: input.source,
    threads: [{ source: input.source, id: input.thread }],
    actor: { source: input.source, id: input.actor },
    human: true,
    addressed: 'direct',
    at,
    text: 'owner message',
    channel: { source: input.source, thread: input.thread, ...(input.address ? { address: input.address } : {}) },
    meta: {},
  }
  store.putDoc('trigger', trigger.id, trigger)
  store.putDoc('disposition', trigger.id, { at, fanout: [], context: [] } satisfies Disposition)
  return trigger
}

function recordDraft(externalId: string): ConnectorDraft {
  return {
    service: 'gmail', kind: 'message', externalId, title: externalId,
    text: 'from=sender@example.test useful update',
    occurredAt: new Date(T0 - 5 * MIN).toISOString(),
    updatedAt: new Date(T0 - 5 * MIN).toISOString(),
    wake: true, wakeReason: 'unread important mail',
  }
}

function makeScheduler(input: {
  store: Store
  index: ConnectorIndex
  api: GoogleWorkspaceApi
  config?: Record<string, unknown>
  admission?: { actors?: string[]; dropSelf?: string[]; groups?: string[] }
}): { runner: ConnectorWakeScheduler; fired: Trigger[] } {
  const config = normalizeConnectorConfig({
    enabled: true,
    google: { services: ['gmail'], ...(input.config?.google as Record<string, unknown> | undefined) },
    wake: {
      enabled: true, services: ['gmail'], source: 'im', thread: 'old-private-ref', chatId: 'fixture-chat-a',
      minIntervalMinutes: 15, maxPerDay: 3,
      ...(input.config?.wake as Record<string, unknown> | undefined),
    },
  })
  const fired: Trigger[] = []
  const runner = new ConnectorWakeScheduler({
    now: () => T0 + 16 * MIN,
    store: input.store,
    config,
    index: input.index,
    api: input.api,
    proactive: normalizeProactiveConfig({ quietStart: '23:00', quietEnd: '08:00', timezone: 'UTC' }),
    ...(input.admission ? { admission: input.admission } : {}),
    fire: trigger => {
      fired.push(trigger)
      input.store.putDoc('trigger', trigger.id, trigger)
      input.store.putDoc('disposition', trigger.id, {
        at: new Date(T0 + 16 * MIN).toISOString(), fanout: [], context: [],
      } satisfies Disposition)
    },
  })
  return { runner, fired }
}

function noRecords(): GoogleWorkspaceApi {
  return { async fetch() { return [] } }
}

function wakeState(store: Store, pending: ConnectorPendingWake[] = []): void {
  store.putDoc('connector_wake', 'state', {
    lastCheckAt: T0,
    cursors: { gmail: new Date(T0).toISOString() },
    pending,
    wakes: [],
    notified: [],
  })
}

function feishuPending(index: ConnectorIndex, channel: NonNullable<Trigger['channel']>, actor: Trigger['actor'], suffix: string): ConnectorPendingWake {
  const record = index.upsert([recordDraft(suffix)]).records[0]!
  return {
    at: T0,
    recordId: record.id,
    service: 'gmail',
    trigger: connectorTrigger(record, { channel, actor }, T0),
  }
}

describe('connector wake current route authorization', () => {
  for (const role of ['fresh', 'pending'] as const) {
    for (const field of ['source', 'thread'] as const) {
      it(`${role} admission rejects a captured private recipient after current ${field} changes`, async () => {
        const { store, index } = setup()
        const originalOwner = seedOwner(store, {
          id: TARGET_ID, source: 'im', thread: 'old-private-ref', actor: 'owner-a',
          address: { provider: 'feishu', chat_id: 'fixture-chat-a', chat_type: 'p2p' },
        })
        seedOwner(store, { id: 'trg_cli_owner', source: 'cli', thread: 'local', actor: 'you' })
        const candidate = recordDraft(`auth-${role}-${field}`)
        const pending = feishuPending(index, originalOwner.channel!, originalOwner.actor, candidate.externalId)
        const originalRoute = structuredClone(pending.trigger.channel)
        if (role === 'pending') wakeState(store, [pending])
        else wakeState(store)
        const { runner, fired } = makeScheduler({
          store, index,
          api: { async fetch() { return role === 'fresh' ? [candidate] : [] } },
        })
        const opts = runner as unknown as { opts: { config: ReturnType<typeof normalizeConnectorConfig> } }
        let changed = false
        const changePolicy = () => {
          if (changed) return
          changed = true
          if (field === 'source') {
            opts.opts.config.wake.source = 'cli'
            opts.opts.config.wake.thread = 'local'
          } else {
            opts.opts.config.wake.thread = 'new-private-ref'
          }
        }
        if (role === 'fresh') {
          const put = store.putDoc.bind(store)
          store.putDoc = ((kind: string, id: string, value: unknown) => {
            const result = put(kind, id, value)
            if (kind === 'connector_wake' && (value as { pending?: unknown[] }).pending?.length) changePolicy()
            return result
          }) as typeof store.putDoc
        } else {
          const get = store.getDoc.bind(store)
          store.getDoc = ((kind: string, id: string) => {
            const result = get(kind, id)
            if (kind === 'disposition' && id === TARGET_ID) changePolicy()
            return result
          }) as typeof store.getDoc
        }

        await runner.poll(T0 + 16 * MIN)
        expect(changed).toBe(true)
        expect(fired).toEqual([])
        expect(store.getDoc('disposition', pending.trigger.id)).toBeUndefined()
        const state = loadConnectorWakeState(store)
        expect(state.wakes).toEqual([])
        expect(state.lastWakeAt).toBeUndefined()
        expect(state.pending ?? []).toHaveLength(0)
        expect(state.notified?.some(row => row.triggerId === pending.trigger.id)).toBe(true)
        expect(pending.trigger.channel).toEqual(originalRoute)

        // A later source revision may use the newly configured, already admitted CLI target.
        const next = recordDraft(`auth-next-${role}-${field}`)
        const nextScheduler = makeScheduler({ store, index, api: { async fetch() { return [next] } } })
        const nextOpts = nextScheduler.runner as unknown as { opts: { config: ReturnType<typeof normalizeConnectorConfig> } }
        nextOpts.opts.config.wake.source = 'cli'
        nextOpts.opts.config.wake.thread = 'local'
        await nextScheduler.runner.poll(T0 + 32 * MIN)
        expect(nextScheduler.fired).toHaveLength(1)
        expect(nextScheduler.fired[0]?.channel).toMatchObject({ source: 'cli', thread: 'local' })
      })
    }
  }

  it('does not route a recovered incomplete original to the current replacement recipient', async () => {
    const { store, index } = setup()
    const owner = seedOwner(store, {
      id: TARGET_ID, source: 'im', thread: 'old-private-ref', actor: 'owner-a',
      address: { provider: 'feishu', chat_id: 'fixture-chat-a', chat_type: 'p2p' },
    })
    const pending = feishuPending(index, owner.channel!, owner.actor, 'recovered-incomplete')
    const originalRoute = structuredClone(pending.trigger.channel)
    store.putDoc('connector_wake', 'state', {
      lastCheckAt: T0, cursors: { gmail: new Date(T0).toISOString() },
      incomplete: [{ pending, reason: 'repaired-intake', isolatedAt: T0 }], wakes: [], notified: [],
    })
    const { runner, fired } = makeScheduler({ store, index, api: noRecords() })
    const get = store.getDoc.bind(store)
    store.getDoc = ((kind: string, id: string) => {
      const result = get(kind, id)
      if (kind === 'disposition' && id === TARGET_ID) {
        const config = (runner as unknown as { opts: { config: ReturnType<typeof normalizeConnectorConfig> } }).opts.config
        config.wake.thread = 'new-private-ref'
      }
      return result
    }) as typeof store.getDoc
    await runner.poll(T0 + 16 * MIN)
    expect(fired).toEqual([])
    const state = loadConnectorWakeState(store)
    expect(state.pending ?? []).toHaveLength(0)
    expect(state.incomplete ?? []).toHaveLength(0)
    expect(state.wakes).toEqual([])
    expect(state.notified?.some(row => row.triggerId === pending.trigger.id)).toBe(true)
    expect(pending.trigger.channel).toEqual(originalRoute)
  })

  it('reauthorizes the original route after trusted uncertain Calendar provenance repair', async () => {
    const { store, index } = setup()
    const owner = seedOwner(store, {
      id: TARGET_ID, source: 'im', thread: 'old-private-ref', actor: 'owner-a',
      address: { provider: 'feishu', chat_id: 'fixture-chat-a', chat_type: 'p2p' },
    })
    const event = recordDraft('recovered-uncertain-route')
    const record = index.upsert([{
      ...event,
      service: 'calendar', kind: 'event',
      occurredAt: new Date(T0 + 30 * MIN).toISOString(),
      wakeReason: 'calendar event starting soon',
    }]).records[0]!
    const trigger = connectorTrigger(record, { channel: owner.channel!, actor: owner.actor }, T0)
    const pending: ConnectorPendingWake = {
      at: T0,
      recordId: record.id,
      service: 'calendar',
      trigger,
      calendarProvenance: {
        version: 1, kind: 'event', occurredAt: record.occurredAt,
        updatedAt: record.updatedAt, wakeReason: record.wakeReason,
      },
    }
    store.putDoc('connector_wake', 'state', {
      lastCheckAt: T0, cursors: { calendar: new Date(T0).toISOString() },
      uncertain: [{ pending, reason: 'calendar-provenance-unavailable', isolatedAt: T0 }],
      wakes: [], notified: [],
    })
    const originalRoute = structuredClone(trigger.channel)
    const { runner, fired } = makeScheduler({
      store, index, api: noRecords(),
      config: { google: { services: ['calendar'] }, wake: { services: ['calendar'] } },
    })
    const get = store.getDoc.bind(store)
    store.getDoc = ((kind: string, id: string) => {
      const result = get(kind, id)
      if (kind === 'disposition' && id === TARGET_ID) {
        (runner as unknown as { opts: { config: ReturnType<typeof normalizeConnectorConfig> } })
          .opts.config.wake.thread = 'new-private-ref'
      }
      return result
    }) as typeof store.getDoc
    await runner.poll(T0 + 16 * MIN)
    expect(fired).toEqual([])
    const state = loadConnectorWakeState(store)
    expect(state.pending ?? []).toHaveLength(0)
    expect(state.uncertain ?? []).toHaveLength(0)
    expect(state.wakes).toEqual([])
    expect(state.notified?.some(row => row.triggerId === trigger.id)).toBe(true)
    expect(trigger.channel).toEqual(originalRoute)
  })

  it('rechecks chat identity, actor admission, and connector service enablement at the final boundary', async () => {
    for (const gate of ['chat-id', 'actor', 'google-service'] as const) {
      const { store, index } = setup()
      const owner = seedOwner(store, {
        id: TARGET_ID, source: 'im', thread: 'old-private-ref', actor: 'owner-a',
        address: { provider: 'feishu', chat_id: 'fixture-chat-a', chat_type: 'p2p' },
      })
      const candidate = recordDraft(`current-${gate}`)
      const candidateRecord = index.upsert([candidate]).records[0]!
      const expectedTriggerId = connectorTrigger(candidateRecord, { channel: owner.channel!, actor: owner.actor }, T0).id
      wakeState(store)
      const { runner, fired } = makeScheduler({
        store, index, api: { async fetch() { return [candidate] } },
        ...(gate === 'actor' ? { admission: { actors: ['owner-a'] } } : {}),
      })
      const opts = runner as unknown as {
        opts: { config: ReturnType<typeof normalizeConnectorConfig>; admission?: { actors?: string[] } }
      }
      const put = store.putDoc.bind(store)
      let changed = false
      store.putDoc = ((kind: string, id: string, value: unknown) => {
        const result = put(kind, id, value)
        if (!changed && kind === 'connector_wake' && (value as { pending?: unknown[] }).pending?.length) {
          changed = true
          if (gate === 'chat-id') opts.opts.config.wake.chatId = 'fixture-chat-b'
          else if (gate === 'actor') opts.opts.admission!.actors = ['another-owner']
          else opts.opts.config.google.services = []
        }
        return result
      }) as typeof store.putDoc
      await runner.poll(T0 + 16 * MIN)
      expect(changed).toBe(true)
      expect(fired).toEqual([])
      expect(store.getDoc('disposition', expectedTriggerId)).toBeUndefined()
      const state = loadConnectorWakeState(store)
      expect(state.wakes).toEqual([])
      expect(state.lastWakeAt).toBeUndefined()
      if (gate === 'chat-id') {
        expect(state.pending).toBeUndefined()
        expect(state.notified?.some(row => row.triggerId === expectedTriggerId)).toBe(true)
      } else {
        expect(state.pending).toHaveLength(1)
        expect(state.notified).toEqual([])
      }
      expect(owner.channel?.address?.chat_id).toBe('fixture-chat-a')
    }
  })

  it('keeps a pending wake when shutdown starts at the durable final boundary', async () => {
    const { store, index } = setup()
    const owner = seedOwner(store, {
      id: TARGET_ID, source: 'im', thread: 'old-private-ref', actor: 'owner-a',
      address: { provider: 'feishu', chat_id: 'fixture-chat-a', chat_type: 'p2p' },
    })
    const pending = feishuPending(index, owner.channel!, owner.actor, 'shutdown-final-boundary')
    wakeState(store)
    const { runner, fired } = makeScheduler({
      store, index, api: { async fetch() { return [recordDraft('shutdown-final-boundary')] } },
    })
    const put = store.putDoc.bind(store)
    store.putDoc = ((kind: string, id: string, value: unknown) => {
      const result = put(kind, id, value)
      if (kind === 'connector_wake' && (value as { pending?: unknown[] }).pending?.length) void runner.stop()
      return result
    }) as typeof store.putDoc
    await runner.poll(T0 + 16 * MIN)
    expect(fired).toEqual([])
    expect(store.getDoc('disposition', pending.trigger.id)).toBeUndefined()
    expect(loadConnectorWakeState(store).wakes).toEqual([])
  })
})

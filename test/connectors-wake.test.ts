import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Replies } from '../src/core/replies.ts'
import type { Host } from '../src/core/host.ts'
import { routerPromptFor } from '../src/harness/loop.ts'
import { Metrics } from '../src/metrics/metrics.ts'
import { normalizeProactiveConfig } from '../src/harness/proactive.ts'
import {
  CONNECTOR_TRIGGER_PREFIX,
  ConnectorWakeScheduler,
  isConnectorWakeTicket,
  loadConnectorWakeState,
} from '../src/connectors/wake.ts'
import { normalizeConnectorConfig } from '../src/connectors/config.ts'
import { ConnectorIndex } from '../src/connectors/index-store.ts'
import type { GoogleWorkspaceApi } from '../src/connectors/google.ts'
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
  return { home, store, index: new ConnectorIndex(store, { now: () => new Date(T0) }) }
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

function scheduler(input: {
  store: Store
  index: ConnectorIndex
  api: GoogleWorkspaceApi
  config?: Record<string, unknown>
  admission?: { actors?: string[]; dropSelf?: string[]; groups?: string[] }
  quiet?: { quietStart: string; quietEnd: string; timezone: string }
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
    now: () => T0,
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
    fire: trigger => {
      fired.push(trigger)
      input.store.putDoc('trigger', trigger.id, trigger)
    },
    log: line => { lines.push(line) },
  })
  return { runner, fired, lines }
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
    const { runner, fired, lines } = scheduler({ store, index, api: fakeApi([draft()]) })

    const backfill = await runner.poll(T0)
    expect(backfill.action).toBe('backfill')
    expect(backfill.indexed).toBe(1)
    expect(fired).toHaveLength(0)
    expect(index.stats().count).toBe(1)

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
    expect(state.notified).toHaveLength(1)
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
    const deniedByActor = scheduler({
      store: byActor.store,
      index: byActor.index,
      api: fakeApi([draft()]),
      admission: { actors: ['someone-else'] },
    })
    expect((await deniedByActor.runner.poll(T0)).action).toBe('backfill')
    expect((await deniedByActor.runner.poll(T0 + 16 * MIN)).action).toBe('admission-denied')
    expect(deniedByActor.fired).toHaveLength(0)

    const bySelf = setup()
    seedOwnerThread(bySelf.store)
    const deniedBySelf = scheduler({
      store: bySelf.store,
      index: bySelf.index,
      api: fakeApi([draft({ externalId: 'message-self' })]),
      admission: { dropSelf: ['you'] },
    })
    expect((await deniedBySelf.runner.poll(T0)).action).toBe('backfill')
    expect((await deniedBySelf.runner.poll(T0 + 16 * MIN)).action).toBe('admission-denied')
    expect(deniedBySelf.fired).toHaveLength(0)

    const byGroup = setup()
    seedOwnerThread(byGroup.store)
    const deniedByGroup = scheduler({
      store: byGroup.store,
      index: byGroup.index,
      api: fakeApi([draft({ externalId: 'message-group' })]),
      admission: { groups: ['oc_owner'] },
    })
    expect((await deniedByGroup.runner.poll(T0)).action).toBe('backfill')
    expect((await deniedByGroup.runner.poll(T0 + 16 * MIN)).action).toBe('admission-denied')
    expect(deniedByGroup.fired).toHaveLength(0)
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
    const { runner, fired } = scheduler({
      store,
      index,
      api: fakeApi([draft({
        service: 'docs',
        kind: 'document',
        externalId: 'doc-1',
        title: 'Shared roadmap',
        wakeReason: 'shared document changed by another person',
      })]),
    })
    expect((await runner.poll(T0)).action).toBe('backfill')
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
    expect((await runner.poll(T0 + 16 * MIN)).action).toBe('wake')
    expect(fired[0]?.text).toContain('service=calendar')
  })

  it('keeps an ingress failure in the durable pending wake outbox', async () => {
    const { store, index } = setup()
    seedOwnerThread(store)
    store.putDoc('connector_wake', 'state', {
      lastCheckAt: T0,
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

  it('replays an outbox wake after restart when the crash precedes ingress persistence', async () => {
    const { store, index } = setup()
    seedOwnerThread(store)
    store.putDoc('connector_wake', 'state', { lastCheckAt: T0, wakes: [], notified: [] })
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

  it('recognizes ingress accepted before a crash and does not replay the Trigger', async () => {
    const { store, index } = setup()
    seedOwnerThread(store)
    store.putDoc('connector_wake', 'state', { lastCheckAt: T0, wakes: [], notified: [] })
    const first = scheduler({ store, index, api: fakeApi([draft()]) })
    ;(first.runner as unknown as { opts: { fire: (trigger: Trigger) => void } }).opts.fire = trigger => {
      store.putDoc('trigger', trigger.id, trigger)
      throw new Error('simulated crash after ingress commit')
    }
    await first.runner.poll(T0 + 16 * MIN)
    expect(loadConnectorWakeState(store).pending).toHaveLength(1)

    const restarted = scheduler({ store, index, api: fakeApi([draft()]) })
    await restarted.runner.poll(T0 + 32 * MIN)
    expect(restarted.fired).toHaveLength(0)
    expect(loadConnectorWakeState(store).pending ?? []).toHaveLength(0)
    expect(loadConnectorWakeState(store).notified).toHaveLength(1)
    expect(store.listDocs<Trigger>('trigger').filter(trigger => trigger.id.startsWith(CONNECTOR_TRIGGER_PREFIX))).toHaveLength(1)
  })

  it('marks connector wakes as messaging envelopes', () => {
    const ticket = {
      id: 'ticket_1',
      channels: [{
        source: 'cli',
        thread: 'local',
        address: { connector: '1' },
      }],
    } as unknown as Parameters<typeof isConnectorWakeTicket>[0]
    expect(isConnectorWakeTicket(ticket)).toBe(true)
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
      channels: [{ source: 'cli', thread: 'local', address: { connector: '1' } }],
    } as unknown as Ticket
    new Replies(host).acknowledge(ticket)
    expect(store.listReplies()).toEqual([])
    expect(lines.some(line => line.includes('ack-suppressed') && line.includes('channel=connector'))).toBe(true)

    const prompt = routerPromptFor(ticket)
    expect(prompt).toContain('connector=true')
    expect(prompt).toContain('message=CONNECTOR_EVENT')
    expect(prompt).toContain('Do not send an acknowledgement')
    expect(prompt).toContain('call assess_trigger kind=stop')
  })
})

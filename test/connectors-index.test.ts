import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectorIndex } from '../src/connectors/index-store.ts'
import { connectorRecordId, type ConnectorDraft } from '../src/connectors/types.ts'
import { Store } from '../src/store/sqlite.ts'

const homes: string[] = []
const stores: Store[] = []

const T0 = Date.parse('2026-11-05T10:00:00.000Z')

function setup(options: { redact?: (text: string) => string; now?: () => Date } = {}): {
  store: Store
  index: ConnectorIndex
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-connectors-index-'))
  homes.push(home)
  const store = new Store(home)
  stores.push(store)
  return {
    store,
    index: new ConnectorIndex(store, { redact: text => text, ...options }),
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) if (store.isOpen) store.close()
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function draft(overrides: Partial<ConnectorDraft> = {}): ConnectorDraft {
  return {
    service: 'gmail',
    kind: 'message',
    externalId: 'message-1',
    title: 'Invoice for November',
    text: 'from=billing@example.com The invoice is attached',
    occurredAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    ...overrides,
  }
}

describe('connector index', () => {
  it('stores and queries records without touching long-term memory', () => {
    const { store, index } = setup({ now: () => new Date(T0) })
    const result = index.upsert([
      draft(),
      draft({
        service: 'calendar',
        kind: 'event',
        externalId: 'event-1',
        title: 'Design review',
        text: 'location=Room 4',
        occurredAt: new Date(T0 + 60 * 60_000).toISOString(),
        updatedAt: new Date(T0 + 60 * 60_000).toISOString(),
      }),
      draft({
        service: 'docs',
        kind: 'document',
        externalId: 'doc-1',
        title: 'Roadmap notes',
        text: 'shared document changed by another person',
        occurredAt: new Date(T0 - 86_400_000).toISOString(),
        updatedAt: new Date(T0 - 86_400_000).toISOString(),
      }),
    ])
    expect(result).toMatchObject({ inserted: 3, updated: 0, unchanged: 0, skipped: 0 })
    expect(store.listDocs('ltm')).toEqual([])
    expect(store.listDocs('connector')).toHaveLength(3)

    expect(index.query({ text: 'invoice' }).map(record => record.externalId)).toEqual(['message-1'])
    expect(index.query({ text: 'design review' }).map(record => record.externalId)).toEqual(['event-1'])
    expect(index.query({ service: 'docs' }).map(record => record.externalId)).toEqual(['doc-1'])
    expect(index.query().map(record => record.externalId)).toEqual(['event-1', 'message-1', 'doc-1'])
    expect(index.query({ limit: 1 }).map(record => record.externalId)).toEqual(['event-1'])
    expect(index.query({ since: new Date(T0).toISOString() }).map(record => record.externalId))
      .toEqual(['event-1', 'message-1'])
    expect(index.query({ until: new Date(T0).toISOString() }).map(record => record.externalId))
      .toEqual(['doc-1'])
  })

  it('updates a record by service and external id without duplicating it', () => {
    const { store, index } = setup({ now: () => new Date(T0) })
    expect(index.upsert([draft()])).toMatchObject({ inserted: 1, updated: 0 })
    const updated = draft({
      title: 'Invoice for December',
      updatedAt: new Date(T0 + 60_000).toISOString(),
    })
    expect(index.upsert([updated])).toMatchObject({ inserted: 0, updated: 1 })
    expect(store.listDocs('connector')).toHaveLength(1)
    expect(index.get(connectorRecordId('gmail', 'message-1'))?.title).toBe('Invoice for December')
    // The same revision is not written again.
    expect(index.upsert([updated])).toMatchObject({ unchanged: 1 })
  })

  it('refuses index writes without an explicit redactor', () => {
    const { store } = setup()
    expect(() => new ConnectorIndex(store).upsert([draft()])).toThrow(/explicit redaction function/)
  })

  it('redacts title and body before storage and query', () => {
    const { index } = setup({
      now: () => new Date(T0),
      redact: text => text.replace('SECRET-VALUE', '[redacted]'),
    })
    index.upsert([draft({
      title: 'Token SECRET-VALUE',
      text: 'body SECRET-VALUE',
      participants: ['SECRET-VALUE@example.com'],
    })])
    const [record] = index.query({ text: 'token' })
    expect(record?.title).toBe('Token [redacted]')
    expect(record?.text).toBe('body [redacted]')
    expect(record?.participants).toEqual(['[redacted]@example.com'])
    expect(JSON.stringify(index.query())).not.toContain('SECRET-VALUE')
  })

  it('prunes by count and age deterministically', () => {
    const { store, index } = setup({ now: () => new Date(T0) })
    index.upsert([
      draft({ externalId: 'old', occurredAt: new Date(T0 - 40 * 86_400_000).toISOString() }),
      draft({ externalId: 'middle', occurredAt: new Date(T0 - 20 * 86_400_000).toISOString() }),
      draft({ externalId: 'new', occurredAt: new Date(T0).toISOString() }),
    ])
    expect(index.stats().count).toBe(3)
    expect(index.prune({ maxAgeDays: 30 })).toBe(1)
    expect(index.query().map(record => record.externalId)).toEqual(['new', 'middle'])
    expect(index.prune({ maxRecords: 1 })).toBe(1)
    expect(store.listDocs('connector')).toHaveLength(1)
    expect(index.query().map(record => record.externalId)).toEqual(['new'])
    // Zero disables a dimension.
    expect(index.prune({ maxRecords: 0, maxAgeDays: 0 })).toBe(0)
  })

  it('keeps distinct provider ids distinct even when punctuation normalizes alike', () => {
    const { store, index } = setup({ now: () => new Date(T0) })
    const result = index.upsert([
      draft({ externalId: 'a/b' }),
      draft({ externalId: 'a_b' }),
    ])
    expect(result.inserted).toBe(2)
    expect(new Set(result.records.map(record => record.id)).size).toBe(2)
    expect(store.listDocs('connector')).toHaveLength(2)
  })

  it('keeps ids stable and skips invalid drafts', () => {
    const { index } = setup({ now: () => new Date(T0) })
    const result = index.upsert([
      draft(),
      draft({ externalId: 'bad-date', occurredAt: 'not-a-date' }),
      draft({ service: 'slack' as never, externalId: 'bad-service' }),
    ])
    expect(result).toMatchObject({ inserted: 1, skipped: 2 })
    expect(result.records[0]?.id).toBe(connectorRecordId('gmail', 'message-1'))
    expect(index.query()[0]?.id).toBe(connectorRecordId('gmail', 'message-1'))
  })
})

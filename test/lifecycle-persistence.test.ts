import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LifecycleBus, type LifecycleEvent } from '../src/core/lifecycle.ts'
import { MockModel } from '../src/harness/model.ts'
import { Runtime } from '../src/runtime.ts'
import { LATEST_SCHEMA_VERSION, MIGRATIONS, migrate } from '../src/store/schema.ts'
import { Store } from '../src/store/sqlite.ts'

const homes: string[] = []
const runtimes: Runtime[] = []

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.daemon.stop()
    if (runtime.store.isOpen) runtime.store.close()
  }
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-lifecycle-persistence-'))
  homes.push(home)
  return home
}

function dbPath(home: string): string {
  return path.join(home, 'ds-agent.db')
}

/**
 * A Runtime with no live model, no network, and a long watchdog interval. The
 * tests publish lifecycle events directly; no Engine work is scheduled.
 */
function openRuntime(
  home: string,
  lifecycleMaxEvents?: number,
  lifecycleRetention?: number,
): Runtime {
  const runtime = Runtime.create({
    home,
    model: new MockModel(),
    lifecycleMaxEvents,
    lifecycleRetention,
    jobDelayMs: 0,
    watchdogIntervalMs: 60_000,
    stuckMs: 60_000,
  })
  runtimes.push(runtime)
  return runtime
}

function closeRuntime(runtime: Runtime): void {
  runtime.daemon.stop()
  runtime.store.close()
}

function lifecycleRows(home: string): { id: number; at: string; kind: string; payload: string }[] {
  const db = new DatabaseSync(dbPath(home))
  try {
    return db.prepare(
      'SELECT id, at, kind, payload FROM lifecycle_events ORDER BY id',
    ).all() as { id: number; at: string; kind: string; payload: string }[]
  } finally {
    db.close()
  }
}

function tableNames(home: string): string[] {
  const db = new DatabaseSync(dbPath(home))
  try {
    return (db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all() as { name: string }[]).map(row => row.name)
  } finally {
    db.close()
  }
}

function lifecycleColumns(home: string): string[] {
  const db = new DatabaseSync(dbPath(home))
  try {
    return (db.prepare('PRAGMA table_info(lifecycle_events)').all() as { name: string }[])
      .map(row => row.name)
  } finally {
    db.close()
  }
}

function publishNotice(runtime: Runtime, value: number): LifecycleEvent {
  return runtime.lifecycle.publish({ kind: 'notice', payload: { n: value } })
}

describe('lifecycle event persistence', () => {
  it('caps a fresh database at maxEvents and replays the newest events once, in order', () => {
    const home = tempHome()
    const first = openRuntime(home, 3)

    for (let n = 1; n <= 6; n += 1) publishNotice(first, n)
    const expectedNewest = [
      { kind: 'notice', payload: { n: 4 } },
      { kind: 'notice', payload: { n: 5 } },
      { kind: 'notice', payload: { n: 6 } },
    ]
    expect(first.lifecycle.history).toEqual(expectedNewest)

    const persistedBeforeClose = lifecycleRows(home)
    // The durable log is bounded too: retention defaults to the in-memory cap.
    expect(persistedBeforeClose).toHaveLength(3)
    expect(persistedBeforeClose.map(row => JSON.parse(row.payload) as { n: number })).toEqual(
      [4, 5, 6].map(n => ({ n })),
    )
    expect(persistedBeforeClose.every(row => row.kind === 'notice')).toBe(true)
    expect(persistedBeforeClose.every(row => row.at.length > 0)).toBe(true)
    expect(persistedBeforeClose.map(row => row.id)).toEqual(
      [...persistedBeforeClose.map(row => row.id)].sort((left, right) => left - right),
    )
    closeRuntime(first)

    const second = openRuntime(home, 3)
    // Hydration is bounded keep-newest and produces the same shape as publish:
    // no synthetic `at` field, no duplicate rows, no gaps.
    expect(second.lifecycle.history).toEqual(expectedNewest)
    expect(second.lifecycle.snapshot(10)).toEqual(expectedNewest)

    publishNotice(second, 7)
    expect(second.lifecycle.history).toEqual([
      { kind: 'notice', payload: { n: 5 } },
      { kind: 'notice', payload: { n: 6 } },
      { kind: 'notice', payload: { n: 7 } },
    ])
    closeRuntime(second)

    // Events published before close (4-6) and after reopen (7) are each
    // present exactly once in the replayed window.
    const third = openRuntime(home, 3)
    expect(third.lifecycle.history).toEqual([
      { kind: 'notice', payload: { n: 5 } },
      { kind: 'notice', payload: { n: 6 } },
      { kind: 'notice', payload: { n: 7 } },
    ])
    // Across three opens and seven publishes the table never exceeds the cap.
    expect(lifecycleRows(home).map(row => JSON.parse(row.payload) as { n: number })).toEqual(
      [5, 6, 7].map(n => ({ n })),
    )
  })

  it('supports a larger durable retention window than the in-memory ring', () => {
    const home = tempHome()
    const first = openRuntime(home, 2, 4)
    for (let n = 1; n <= 6; n += 1) publishNotice(first, n)

    // The panel view stays bounded by maxEvents; the audit log keeps 4.
    expect(first.lifecycle.history).toEqual([
      { kind: 'notice', payload: { n: 5 } },
      { kind: 'notice', payload: { n: 6 } },
    ])
    expect(lifecycleRows(home).map(row => JSON.parse(row.payload) as { n: number })).toEqual(
      [3, 4, 5, 6].map(n => ({ n })),
    )
    closeRuntime(first)

    const second = openRuntime(home, 2, 4)
    expect(second.lifecycle.history).toEqual([
      { kind: 'notice', payload: { n: 5 } },
      { kind: 'notice', payload: { n: 6 } },
    ])
    publishNotice(second, 7)
    expect(second.lifecycle.history).toEqual([
      { kind: 'notice', payload: { n: 6 } },
      { kind: 'notice', payload: { n: 7 } },
    ])
    expect(lifecycleRows(home).map(row => JSON.parse(row.payload) as { n: number })).toEqual(
      [4, 5, 6, 7].map(n => ({ n })),
    )
    closeRuntime(second)

    const third = openRuntime(home, 2, 4)
    expect(third.lifecycle.history).toEqual([
      { kind: 'notice', payload: { n: 6 } },
      { kind: 'notice', payload: { n: 7 } },
    ])
    expect(lifecycleRows(home)).toHaveLength(4)
  })

  it('raises retention below the in-memory cap so replay is never shorter than the ring', () => {
    const home = tempHome()
    const first = openRuntime(home, 4, 2)
    for (let n = 1; n <= 8; n += 1) publishNotice(first, n)
    closeRuntime(first)

    expect(lifecycleRows(home).map(row => JSON.parse(row.payload) as { n: number })).toEqual(
      [5, 6, 7, 8].map(n => ({ n })),
    )
    const second = openRuntime(home, 4, 2)
    expect(second.lifecycle.history).toEqual([
      { kind: 'notice', payload: { n: 5 } },
      { kind: 'notice', payload: { n: 6 } },
      { kind: 'notice', payload: { n: 7 } },
      { kind: 'notice', payload: { n: 8 } },
    ])
  })

  it('round-trips JSON payloads exactly and stores only the published metadata', () => {
    const home = tempHome()
    const first = openRuntime(home, 1000)
    const metadata = {
      ticketId: 'ticket_1',
      title: 'Fix the login timeout',
      speculative: false,
      threads: ['github/42', 'im/topic-1'],
    }
    const nested = {
      nested: { list: [1, 'two', null, { three: true }] },
      // A secret-shaped string is not separately scrubbed: the persistence
      // boundary stores the existing lifecycle payload as given. The runtime
      // must never put secrets here in the first place (see model/tool body
      // assertion below).
      token: 'sk-test-not-a-real-credential',
      unicode: 'nudges 世界',
    }
    first.lifecycle.publish({ kind: 'ticket.created', payload: metadata })
    first.lifecycle.publish({ kind: 'notice', payload: nested })
    closeRuntime(first)

    const rows = lifecycleRows(home)
    expect(rows).toHaveLength(2)
    expect(JSON.parse(rows[0]!.payload)).toEqual(metadata)
    expect(JSON.parse(rows[1]!.payload)).toEqual(nested)

    const reopened = openRuntime(home, 1000)
    expect(reopened.lifecycle.history).toEqual([
      { kind: 'ticket.created', payload: metadata },
      { kind: 'notice', payload: nested },
    ])

    // Only existing event metadata is stored; no message body, tool output,
    // or file contents are added by the sink.
    const storedKeys = Object.keys(JSON.parse(rows[0]!.payload) as Record<string, unknown>)
    expect(storedKeys).toEqual(['ticketId', 'title', 'speculative', 'threads'])
    for (const forbidden of ['body', 'text', 'output', 'toolOutput', 'content', 'file']) {
      expect(rows.some(row => Object.hasOwn(JSON.parse(row.payload) as object, forbidden))).toBe(false)
    }
  })

  it('persistence failure is isolated: publish resolves and the in-memory ring keeps working', () => {
    const failures: unknown[] = []
    let appended = 0
    const bus = new LifecycleBus(2, {
      append: () => {
        appended += 1
        throw new Error('injected sink failure')
      },
      recent: () => [],
    }, (error, operation) => failures.push({ error, operation }))

    const received: LifecycleEvent[] = []
    bus.subscribe('notice', event => received.push(event))

    const first = bus.publish({ kind: 'notice', payload: 1 })
    const second = bus.publish({ kind: 'notice', payload: 2 })
    const third = bus.publish({ kind: 'notice', payload: 3 })

    expect(first).toEqual({ kind: 'notice', payload: 1 })
    expect(second).toEqual({ kind: 'notice', payload: 2 })
    expect(third).toEqual({ kind: 'notice', payload: 3 })
    expect(received).toHaveLength(3)
    expect(bus.history).toEqual([
      { kind: 'notice', payload: 2 },
      { kind: 'notice', payload: 3 },
    ])
    expect(bus.snapshot(10)).toEqual([
      { kind: 'notice', payload: 2 },
      { kind: 'notice', payload: 3 },
    ])
    // Every append was attempted; the failure is logged exactly once.
    expect(appended).toBe(3)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ operation: 'append' })
  })

  it('hydration failure leaves the bus empty but usable and reports once', () => {
    const reported: string[] = []
    const bus = new LifecycleBus(10, {
      append: () => undefined,
      recent: () => {
        throw new Error('injected recent failure')
      },
    }, (_error, operation) => reported.push(operation))

    expect(bus.hydrateFromSink()).toBe(false)
    expect(bus.history).toEqual([])
    expect(bus.publish({ kind: 'notice', payload: { n: 1 } })).toEqual({
      kind: 'notice',
      payload: { n: 1 },
    })
    expect(bus.history).toHaveLength(1)
    expect(reported).toEqual(['recent'])
  })

  it('a throwing persistence-error reporter cannot escape publish or hydration', () => {
    const bus = new LifecycleBus(10, {
      append: () => {
        throw new Error('injected sink failure')
      },
      recent: () => {
        throw new Error('injected recent failure')
      },
    }, () => {
      throw new Error('injected reporter failure')
    })

    const received: LifecycleEvent[] = []
    bus.subscribe('notice', event => received.push(event))

    const event = { kind: 'notice', payload: { n: 1 } }
    expect(bus.publish(event)).toBe(event)
    // Report failure before listeners; the reporter exception must not skip them.
    expect(received).toEqual([event])
    expect(bus.history).toEqual([event])

    const hydrated = new LifecycleBus(10, {
      append: () => undefined,
      recent: () => {
        throw new Error('injected recent failure')
      },
    }, () => {
      throw new Error('injected reporter failure')
    })
    expect(hydrated.hydrateFromSink()).toBe(false)
    expect(hydrated.history).toEqual([])
  })

  it('hydrates only maxEvents from a large persisted log', () => {
    const home = tempHome()
    const first = openRuntime(home, 1000)
    for (let n = 1; n <= 8; n += 1) publishNotice(first, n)
    closeRuntime(first)

    const second = openRuntime(home, 3)
    expect(second.lifecycle.history).toEqual([
      { kind: 'notice', payload: { n: 6 } },
      { kind: 'notice', payload: { n: 7 } },
      { kind: 'notice', payload: { n: 8 } },
    ])
    expect(new Set(second.lifecycle.history.map(event => JSON.stringify(event))).size).toBe(3)
    // Startup prunes the oversized durable log to the new retention cap.
    expect(lifecycleRows(home).map(row => JSON.parse(row.payload) as { n: number })).toEqual(
      [6, 7, 8].map(n => ({ n })),
    )
  })
})

describe('lifecycle_events schema migration', () => {
  it('upgrades an existing version 2 database to version 3 without data loss', () => {
    const home = tempHome()
    const db = new DatabaseSync(dbPath(home))
    try {
      // Build exactly the version 2 shape and leave a durable row behind.
      expect(migrate(db, MIGRATIONS.filter(migration => migration.version <= 2), 2)).toBe(2)
      db.prepare('INSERT INTO documents(kind, id, payload) VALUES(?, ?, ?)')
        .run('note', 'keep_me', JSON.stringify({ body: 'survives v3' }))
    } finally {
      db.close()
    }
    const migrationsBefore = lifecycleMigrations(home)
    expect(migrationsBefore.map(row => row.version)).toEqual([1, 2])

    const store = new Store(home)
    try {
      expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
      expect(store.getDoc('note', 'keep_me')).toEqual({ body: 'survives v3' })
    } finally {
      store.close()
    }

    expect(tableNames(home)).toContain('lifecycle_events')
    expect(lifecycleColumns(home)).toEqual(['id', 'at', 'kind', 'payload'])
    const migrationsAfter = lifecycleMigrations(home)
    expect(migrationsAfter.map(row => row.version)).toEqual([1, 2, LATEST_SCHEMA_VERSION])
    // Version 1 and 2 ledger rows are untouched by the version 3 step.
    expect(migrationsAfter.slice(0, 2)).toEqual(migrationsBefore)
  })

  it('creates the lifecycle log on a fresh database at the latest version', () => {
    const home = tempHome()
    const store = new Store(home)
    try {
      expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
      expect(LATEST_SCHEMA_VERSION).toBe(3)
    } finally {
      store.close()
    }

    expect(tableNames(home)).toContain('lifecycle_events')
    expect(lifecycleColumns(home)).toEqual(['id', 'at', 'kind', 'payload'])
    expect(lifecycleMigrations(home).map(row => row.version)).toEqual([1, 2, 3])

    // Reopening applies no migration twice.
    const reopened = new Store(home)
    try {
      expect(reopened.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    } finally {
      reopened.close()
    }
    expect(lifecycleMigrations(home).map(row => row.version)).toEqual([1, 2, 3])
  })
})

function lifecycleMigrations(home: string): { version: number; applied_at: string }[] {
  const db = new DatabaseSync(dbPath(home))
  try {
    return db.prepare(
      'SELECT version, applied_at FROM schema_migrations ORDER BY version',
    ).all() as { version: number; applied_at: string }[]
  } finally {
    db.close()
  }
}

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readT48Journal } from '../src/measurement/t48-journal.ts'
import {
  readCorpusState,
  resolveT48MeasurementHome,
  T48_INCREMENTAL_SAMPLES,
  runT48PersistentIncrementalStep,
} from '../src/measurement/t48-persistent-store.ts'
import { runT48WallClockObservation, readWallClockState } from '../scripts/t48-wall-clock-observe.ts'
import { Store } from '../src/store/sqlite.ts'
import type { LongTermMemoryEntry } from '../src/memory/long-term.ts'
import { tempHome } from './fixtures.ts'

describe('T48 wall-clock observation (persistent corpus, not month-scale acceptance)', () => {
  it('accumulates corpus across invocations with syntheticWorkload true and syntheticClock false', () => {
    const home = tempHome()
    const journal = `${home}/wall.jsonl`
    const env = { ...process.env, DS_AGENT_T48_TEST_HOT_MAX_AGE_DAYS: '0',
      DS_AGENT_T48_TEST_HOT_MAX_ENTRIES: '1000' }

    const first = runT48WallClockObservation({ home, journalPath: journal, minIntervalMs: 0, force: true, env })
    expect(first.action).toBe('appended')
    expect(first.state.corpusSamplesInserted).toBe(1)

    const second = runT48WallClockObservation({ home, journalPath: journal, minIntervalMs: 0, force: true, env })
    expect(second.action).toBe('appended')
    expect(second.state.corpusSamplesInserted).toBe(2)

    const rows = readT48Journal(journal)
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.syntheticClock === false)).toBe(true)
    expect(rows.every(r => r.syntheticWorkload === true)).toBe(true)
    expect(readWallClockState(home)?.samples).toBe(2)

    const measurementHome = resolveT48MeasurementHome(home)
    const corpus = readCorpusState(measurementHome)
    expect(corpus?.insertedSampleIndices).toEqual([0, 1])

    const store = new Store(measurementHome)
    try {
      const docs = store.listDocs<LongTermMemoryEntry>('ltm')
      const hotBilling = docs.filter(
        e => (e.tier ?? 'hot') === 'hot' && e.tags?.includes('billing'),
      )
      expect(hotBilling.length).toBeGreaterThanOrEqual(1)
    } finally {
      store.close()
    }
  })

  it('skips when interval not elapsed', () => {
    const home = tempHome()
    const journal = `${home}/wall2.jsonl`
    runT48WallClockObservation({ home, journalPath: journal, force: true })
    const skipped = runT48WallClockObservation({
      home,
      journalPath: journal,
      minIntervalMs: 86_400_000,
      force: false,
    })
    expect(skipped.action).toBe('skipped')
  })

  it('reopens the same home after a simulated process exit and measures older fixture recall', () => {
    const home = tempHome()
    const journal = `${home}/wall-restart.jsonl`
    const env = { ...process.env, DS_AGENT_T48_TEST_HOT_MAX_AGE_DAYS: '0',
      DS_AGENT_T48_TEST_HOT_MAX_ENTRIES: '1' }

    for (let i = 0; i < T48_INCREMENTAL_SAMPLES.length; i++) {
      runT48WallClockObservation({
        home,
        journalPath: journal,
        minIntervalMs: 0,
        force: true,
        env,
      })
    }

    const { report } = runT48PersistentIncrementalStep({
      home: resolveT48MeasurementHome(home),
      wallClockMeasurement: true,
      env,
      forceInsert: false,
    })
    expect(report.metrics.insertedSamples).toBe(T48_INCREMENTAL_SAMPLES.length)
    expect(report.metrics.coldRecallAt3ForInserted).toBe(1)
    expect(report.metrics.unrelatedQueryHits).toBe(0)
    expect(report.metrics.topBillingQueryIsBilling).toBe(true)
    expect(report.syntheticWorkload).toBe(true)
    expect(report.wallClockMeasurement).toBe(true)
    expect(fs.existsSync(path.join(resolveT48MeasurementHome(home), 'ds-agent.db'))).toBe(true)
    expect(fs.existsSync(path.join(home, 'ds-agent.db'))).toBe(false)
  })

  it('preserves ordinary runtime memory while fixture retention runs in measurement storage', () => {
    const home = tempHome()
    const production = new Store(home)
    try {
      production.putDoc('ltm', 'production-memory', {
        id: 'production-memory', text: 'real operator memory', tier: 'hot', createdAt: new Date().toISOString(),
      })
    } finally {
      production.close()
    }

    runT48WallClockObservation({
      home,
      journalPath: path.join(home, 'isolated.jsonl'),
      force: true,
      env: { ...process.env, DS_AGENT_T48_TEST_HOT_MAX_AGE_DAYS: '0' },
    })

    const reopened = new Store(home)
    try {
      expect(reopened.getDoc('ltm', 'production-memory')).toMatchObject({ text: 'real operator memory' })
    } finally {
      reopened.close()
    }
  })

  it('refuses a concurrent observation before changing journal or state', () => {
    const home = tempHome()
    const journal = path.join(home, 'locked.jsonl')
    const lock = path.join(home, '.ds-agent/measurement/t48-wall-clock.lock')
    fs.mkdirSync(path.dirname(lock), { recursive: true })
    fs.writeFileSync(lock, JSON.stringify({
      owner: 'active-observer',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }), 'utf8')
    expect(() => runT48WallClockObservation({ home, journalPath: journal, force: true }))
      .toThrow('T48 wall-clock observation already running')
    expect(fs.existsSync(journal)).toBe(false)
    expect(readWallClockState(home)).toBeUndefined()
  })

  it('reclaims an expired observation lease after a crashed process', () => {
    const home = tempHome()
    const journal = path.join(home, 'expired-lock.jsonl')
    const lock = path.join(home, '.ds-agent/measurement/t48-wall-clock.lock')
    fs.mkdirSync(path.dirname(lock), { recursive: true })
    fs.writeFileSync(lock, JSON.stringify({
      owner: 'crashed-observer',
      expiresAt: '2026-01-01T00:00:00.000Z',
    }), 'utf8')

    const result = runT48WallClockObservation({
      home,
      journalPath: journal,
      force: true,
      now: () => new Date('2026-01-01T00:01:00.000Z'),
    })
    expect(result.action).toBe('appended')
    expect(fs.existsSync(lock)).toBe(false)
  })

  it('reconciles a crash after fixture persistence without inserting another sample', () => {
    const home = tempHome()
    const journal = path.join(home, 'after-fixture.jsonl')
    expect(() => runT48WallClockObservation({
      home,
      journalPath: journal,
      force: true,
      testFaultAfter: 'fixture',
    })).toThrow('injected T48 fault after fixture')

    const pending = readWallClockState(home)?.pending
    expect(pending).toBeDefined()
    const fixture = readCorpusState(resolveT48MeasurementHome(home))
    expect(fixture?.completedRun?.runId).toBe(pending?.runId)
    expect(fixture?.insertedSampleIndices).toEqual([0])
    expect(readT48Journal(journal)).toEqual([])

    const resumed = runT48WallClockObservation({ home, journalPath: journal, force: true })
    expect(resumed.action).toBe('appended')
    expect(resumed.state.samples).toBe(1)
    expect(resumed.state.pending).toBeUndefined()
    expect(readCorpusState(resolveT48MeasurementHome(home))?.insertedSampleIndices).toEqual([0])
    expect(readT48Journal(journal).map(entry => entry.runId)).toEqual([pending?.runId])
  })

  it('reconciles an insertion-receipt crash without advancing to the next corpus sample', () => {
    const home = tempHome()
    const journal = path.join(home, 'after-insertion-receipt.jsonl')
    expect(() => runT48WallClockObservation({
      home,
      journalPath: journal,
      force: true,
      testFaultAfter: 'fixture-receipt',
    })).toThrow('injected T48 fault after insertion receipt')

    const pending = readWallClockState(home)?.pending
    const fixture = readCorpusState(resolveT48MeasurementHome(home))
    expect(fixture?.inProgressRun?.runId).toBe(pending?.runId)
    expect(fixture?.inProgressRun?.insertedSampleIndex).toBe(0)
    expect(fixture?.completedRun).toBeUndefined()
    expect(fixture?.insertedSampleIndices).toEqual([0])

    const resumed = runT48WallClockObservation({ home, journalPath: journal, force: true })
    expect(resumed.state.samples).toBe(1)
    expect(readCorpusState(resolveT48MeasurementHome(home))?.insertedSampleIndices).toEqual([0])
    expect(readT48Journal(journal).map(entry => entry.runId)).toEqual([pending?.runId])
  })

  it('reconciles a crash after journal append without duplicating the journal row', () => {
    const home = tempHome()
    const journal = path.join(home, 'after-journal.jsonl')
    expect(() => runT48WallClockObservation({
      home,
      journalPath: journal,
      force: true,
      testFaultAfter: 'journal',
    })).toThrow('injected T48 fault after journal')

    const pending = readWallClockState(home)?.pending
    expect(pending).toBeDefined()
    expect(readT48Journal(journal).map(entry => entry.runId)).toEqual([pending?.runId])

    const resumed = runT48WallClockObservation({ home, journalPath: journal, force: true })
    expect(resumed.action).toBe('appended')
    expect(resumed.state.samples).toBe(1)
    expect(resumed.state.pending).toBeUndefined()
    expect(readT48Journal(journal).map(entry => entry.runId)).toEqual([pending?.runId])
  })
})

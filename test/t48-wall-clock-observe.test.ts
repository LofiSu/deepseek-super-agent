import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readT48Journal } from '../src/measurement/t48-journal.ts'
import {
  readCorpusState,
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

    const corpus = readCorpusState(home)
    expect(corpus?.insertedSampleIndices).toEqual([0, 1])

    const store = new Store(home)
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
      home,
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
    expect(fs.existsSync(path.join(home, 'ds-agent.db'))).toBe(true)
  })
})


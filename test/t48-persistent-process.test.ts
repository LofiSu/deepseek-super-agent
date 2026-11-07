import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCorpusState } from '../src/measurement/t48-persistent-store.ts'
import { runT48PersistentIncrementalStep, T48_INCREMENTAL_SAMPLES } from '../src/measurement/t48-persistent-store.ts'
import { tempHome } from './fixtures.ts'

function spawnOneSample(home: string, journal: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '-e',
        `import { runT48WallClockObservation } from './scripts/t48-wall-clock-observe.ts';
        const r = runT48WallClockObservation({ home: process.env.DS_AGENT_HOME!, journalPath: process.env.DS_AGENT_T48_JOURNAL!, minIntervalMs: 0, force: true, env: process.env });
        console.log(JSON.stringify({ inserted: r.state.corpusSamplesInserted }));`,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DS_AGENT_HOME: home,
          DS_AGENT_T48_JOURNAL: journal,
          DS_AGENT_T48_TEST_HOT_MAX_AGE_DAYS: '0',
          DS_AGENT_T48_TEST_HOT_MAX_ENTRIES: '1000',
          CI: 'true',
          DS_AGENT_ALLOW_MOCK_FIXTURE: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let out = ''
    child.stdout?.on('data', (c) => { out += String(c) })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) reject(new Error(`child exit ${code}`))
      else resolve(Number(JSON.parse(out.trim().split('\n').pop()!).inserted))
    })
  })
}

describe('T48 persistent corpus across processes', () => {
  it('child processes append to the same SQLite store and corpus state', async () => {
    const home = tempHome()
    const journal = path.join(home, 'proc.jsonl')
    const first = await spawnOneSample(home, journal)
    expect(first).toBe(1)
    const second = await spawnOneSample(home, journal)
    expect(second).toBe(2)

    expect(readCorpusState(home)?.insertedSampleIndices).toEqual([0, 1])
    expect(fs.existsSync(path.join(home, 'ds-agent.db'))).toBe(true)

    const { report } = runT48PersistentIncrementalStep({
      home,
      wallClockMeasurement: true,
      env: { ...process.env, DS_AGENT_T48_TEST_HOT_MAX_AGE_DAYS: '0', DS_AGENT_T48_TEST_HOT_MAX_ENTRIES: '1000' },
      forceInsert: false,
    })
    expect(report.metrics.insertedSamples).toBe(2)
  }, 60_000)

  it('full corpus in separate steps then reopen recalls all held-out queries', () => {
    const home = tempHome()
    const env = { ...process.env, DS_AGENT_T48_TEST_HOT_MAX_AGE_DAYS: '0', DS_AGENT_T48_TEST_HOT_MAX_ENTRIES: '1' }
    for (let i = 0; i < T48_INCREMENTAL_SAMPLES.length; i++) {
      runT48PersistentIncrementalStep({ home, wallClockMeasurement: true, env })
    }
    const { report } = runT48PersistentIncrementalStep({
      home,
      wallClockMeasurement: true,
      env,
      forceInsert: false,
    })
    expect(report.metrics.insertedSamples).toBe(T48_INCREMENTAL_SAMPLES.length)
    expect(report.metrics.coldDigests).toBeGreaterThanOrEqual(T48_INCREMENTAL_SAMPLES.length)
    expect(report.metrics.coldRecallAt3ForInserted).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import { readT48Journal } from '../src/measurement/t48-journal.ts'
import { runT48WallClockObservation, readWallClockState } from '../scripts/t48-wall-clock-observe.ts'
import { tempHome } from './fixtures.ts'

describe('T48 wall-clock observation (not month-scale acceptance)', () => {
  it('appends syntheticClock:false row and restartable state', () => {
    const home = tempHome()
    const journal = `${home}/wall.jsonl`
    const first = runT48WallClockObservation({ home, journalPath: journal, minIntervalMs: 0, force: true })
    expect(first.action).toBe('appended')
    expect(first.state.samples).toBe(1)

    const second = runT48WallClockObservation({ home, journalPath: journal, minIntervalMs: 0, force: true })
    expect(second.action).toBe('appended')
    expect(second.state.samples).toBe(2)

    const rows = readT48Journal(journal)
    expect(rows.every(r => r.syntheticClock === false)).toBe(true)
    expect(readWallClockState(home)?.samples).toBe(2)
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
})

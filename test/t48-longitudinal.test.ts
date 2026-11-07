import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runT48LongitudinalHarness } from '../scripts/t48-longitudinal-harness.ts'
import { readT48Journal } from '../src/measurement/t48-journal.ts'
import { tempHome } from './fixtures.ts'

describe('T48 longitudinal harness (synthetic)', () => {
  it('accumulates journal rows and recalls after store reopen', () => {
    const home = tempHome()
    const journal = `${home}/journal.jsonl`
    const first = runT48LongitudinalHarness({ home, journalPath: journal, appendJournal: true })
    expect(first.synthetic).toBe(true)
    expect(first.recallAfterRestart.billingHits).toBeGreaterThan(0)
    expect(first.forgetting.unrelatedQueryResults).toBe(0)
    expect(first.contamination.topBillingQueryIsBilling).toBe(true)

    const home2 = tempHome()
    const second = runT48LongitudinalHarness({ home: home2, journalPath: journal, appendJournal: true })
    expect(second.report.metrics.coldRecallAt3).toBe(1)
    const rows = readT48Journal(journal)
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.syntheticClock === true)).toBe(true)
    expect(rows.every(row => row.schemaVersion === 1)).toBe(true)
  })

  it('does not read DS_AGENT_HOME outside the provided temp home', () => {
    const home = tempHome()
    const journal = `${home}/only-here.jsonl`
    runT48LongitudinalHarness({ home, journalPath: journal })
    expect(fs.existsSync(journal)).toBe(true)
    expect(readT48Journal(journal)).toHaveLength(1)
  })
})

/**
 * T48 longitudinal offline harness — synthetic clock only (NOT real elapsed months).
 *
 * Runs the fixture smoke, optionally simulates a second process boundary by
 * reopening the same store, appends JSONL journal rows, and prints metrics.
 *
 * Parent operators may schedule:
 *   DS_AGENT_HOME=/path/to/state CI=true DS_AGENT_ALLOW_MOCK_FIXTURE=1 pnpm t48:long
 *
 * Journal default: $DS_AGENT_HOME/.ds-agent/measurement/t48-journal/t48-measurements.jsonl
 * Override file: DS_AGENT_T48_JOURNAL=/absolute/path.jsonl
 *
 * No network, no live model, no reads of real user memories.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  FIXTURE_CORPUS,
  FIXTURE_READER,
  PROTOCOL_QUERIES,
  runT48MonthScaleProtocol,
} from './t48-month-scale-protocol.ts'
import { SpillBackedLongTermMemory } from '../src/memory/long-term.ts'
import { Store } from '../src/store/sqlite.ts'
import {
  appendT48Journal,
  resolveT48JournalPath,
  type T48JournalEntry,
} from '../src/measurement/t48-journal.ts'

export interface LongitudinalHarnessResult {
  synthetic: true
  journalPath: string
  runId: string
  report: ReturnType<typeof runT48MonthScaleProtocol>
  /** Simulated restart: same store path, new Store + memory instance. */
  recallAfterRestart: { billingHits: number; unrelatedHits: number }
  forgetting: { unrelatedQueryResults: number }
  contamination: { topBillingQueryIsBilling: boolean }
}

export function runT48LongitudinalHarness(options: {
  home?: string
  journalPath?: string
  appendJournal?: boolean
} = {}): LongitudinalHarnessResult {
  const ownsHome = options.home == null
  const home = options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-t48-long-'))
  const report = runT48MonthScaleProtocol({ home })
  const runId = randomUUID()
  const journalPath = options.journalPath ?? resolveT48JournalPath({ ...process.env, DS_AGENT_HOME: home })
  if (options.appendJournal !== false) {
    const entry: T48JournalEntry = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      syntheticClock: true,
      runId,
      report,
    }
    appendT48Journal(journalPath, entry)
  }

  const restarted = new Store(home)
  try {
    const memory = new SpillBackedLongTermMemory(restarted)
    const billingHits = memory.query({
      ticketId: FIXTURE_READER,
      text: 'invoice csv rejected blank rows',
      tier: 'cold',
      limit: 3,
    }).length
    const unrelatedHits = memory.query({
      ticketId: 'ticket_contamination_probe',
      text: 'totally unrelated quantum pizza topology',
      tier: 'cold',
      limit: 3,
    }).length
    const billingTop = memory.query({
      ticketId: FIXTURE_READER,
      text: 'invoice csv rejected blank rows',
      tier: 'cold',
      limit: 1,
    })[0]
    const topBillingQueryIsBilling = (billingTop?.tags ?? []).includes('billing')

    return {
      synthetic: true,
      journalPath,
      runId,
      report,
      recallAfterRestart: { billingHits, unrelatedHits },
      forgetting: { unrelatedQueryResults: unrelatedHits },
      contamination: { topBillingQueryIsBilling },
    }
  } finally {
    restarted.close()
    if (ownsHome) fs.rmSync(home, { recursive: true, force: true })
  }
}

function main(): void {
  const result = runT48LongitudinalHarness({ appendJournal: true })
  console.log('T48 longitudinal harness — SYNTHETIC CLOCK (not calendar-month evidence)')
  console.log(`journal: ${result.journalPath}`)
  console.log(`cold recall@3: ${result.report.metrics.coldRecallAt3}`)
  console.log(`after restart billing hits: ${result.recallAfterRestart.billingHits}`)
  console.log(`unrelated query hits: ${result.forgetting.unrelatedQueryResults}`)
  console.log(`corpus threads: ${FIXTURE_CORPUS.length}, queries: ${PROTOCOL_QUERIES.length}`)
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === entry) main()

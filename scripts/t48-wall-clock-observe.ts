import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  appendT48Journal,
  resolveT48JournalPath,
  type T48JournalEntry,
} from '../src/measurement/t48-journal.ts'
import { runT48LongitudinalHarness } from './t48-longitudinal-harness.ts'

const CADENCE_MS = 24 * 60 * 60 * 1000

export interface WallClockObservationState {
  schemaVersion: 1
  startedAt: string
  home: string
  journalPath: string
  samples: number
  lastSampleAt?: string
}

function statePath(home: string): string {
  return path.join(home, '.ds-agent/measurement/t48-wall-clock-state.json')
}

export function readWallClockState(home: string): WallClockObservationState | undefined {
  const file = statePath(home)
  if (!fs.existsSync(file)) return undefined
  return JSON.parse(fs.readFileSync(file, 'utf8')) as WallClockObservationState
}

export function writeWallClockState(state: WallClockObservationState): void {
  fs.mkdirSync(path.dirname(statePath(state.home)), { recursive: true })
  fs.writeFileSync(statePath(state.home), `${JSON.stringify(state, null, 0)}\n`, 'utf8')
}

/**
 * Appends one wall-clock observation row when interval elapsed (or force).
 * Does NOT flip T48 to calendar-month complete — labels `syntheticClock: false` only for real `recordedAt`.
 */
export function runT48WallClockObservation(options: {
  home: string
  journalPath?: string
  minIntervalMs?: number
  force?: boolean
}): { action: 'appended' | 'skipped'; reason?: string; state: WallClockObservationState } {
  const journalPath = options.journalPath ?? resolveT48JournalPath({
    ...process.env,
    DS_AGENT_HOME: options.home,
  })
  const minIntervalMs = options.minIntervalMs ?? CADENCE_MS
  const prior = readWallClockState(options.home)
  const now = Date.now()
  if (
    !options.force
    && prior?.lastSampleAt
    && now - Date.parse(prior.lastSampleAt) < minIntervalMs
  ) {
    const state: WallClockObservationState = prior
    return { action: 'skipped', reason: 'interval-not-elapsed', state }
  }

  fs.mkdirSync(options.home, { recursive: true })
  const result = runT48LongitudinalHarness({
    journalPath,
    appendJournal: false,
  })
  const entry: T48JournalEntry = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    syntheticClock: false,
    runId: result.runId,
    report: result.report,
  }
  appendT48Journal(journalPath, entry)

  const state: WallClockObservationState = {
    schemaVersion: 1,
    startedAt: prior?.startedAt ?? new Date().toISOString(),
    home: options.home,
    journalPath,
    samples: (prior?.samples ?? 0) + 1,
    lastSampleAt: entry.recordedAt,
  }
  writeWallClockState(state)
  return { action: 'appended', state }
}

function main(): void {
  const home = process.env.DS_AGENT_HOME?.trim()
  if (!home) {
    console.error('t48:observe requires DS_AGENT_HOME (persistent copy, not ephemeral)')
    process.exit(2)
  }
  const force = process.env.DS_AGENT_T48_OBSERVE_FORCE === '1'
  const { action, reason, state } = runT48WallClockObservation({ home, force })
  console.log(`T48 wall-clock observation — NOT calendar-month acceptance (T48 remains [~])`)
  console.log(`action=${action} samples=${state.samples} journal=${state.journalPath}`)
  if (reason) console.log(`reason=${reason}`)
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === entry) main()

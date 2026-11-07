import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  appendT48Journal,
  resolveT48JournalPath,
  type T48JournalEntry,
} from '../src/measurement/t48-journal.ts'
import { runT48PersistentIncrementalStep } from '../src/measurement/t48-persistent-store.ts'

const CADENCE_MS = 24 * 60 * 60 * 1000

export interface WallClockObservationState {
  schemaVersion: 1
  startedAt: string
  home: string
  journalPath: string
  samples: number
  lastSampleAt?: string
  corpusSamplesInserted?: number
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
 * Persists fixture corpus under `home` across invocations; journal rows keep
 * `syntheticWorkload: true` and `syntheticClock: false` (real retention clock only).
 * Does NOT flip T48 to calendar-month complete.
 */
export function runT48WallClockObservation(options: {
  home: string
  journalPath?: string
  minIntervalMs?: number
  force?: boolean
  env?: NodeJS.ProcessEnv
}): { action: 'appended' | 'skipped', reason?: string, state: WallClockObservationState } {
  const journalPath = options.journalPath ?? resolveT48JournalPath({
    ...(options.env ?? process.env),
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
  const { runId, report, state: corpus } = runT48PersistentIncrementalStep({
    home: options.home,
    wallClockMeasurement: true,
    env: options.env,
  })
  const entry: T48JournalEntry = {
    schemaVersion: 1,
    recordedAt: report.recordedAt,
    syntheticClock: false,
    syntheticWorkload: true,
    runId,
    report,
  }
  appendT48Journal(journalPath, entry)

  const state: WallClockObservationState = {
    schemaVersion: 1,
    startedAt: prior?.startedAt ?? report.recordedAt,
    home: options.home,
    journalPath,
    samples: (prior?.samples ?? 0) + 1,
    lastSampleAt: entry.recordedAt,
    corpusSamplesInserted: corpus.insertedSampleIndices.length,
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
  console.log('T48 wall-clock observation — synthetic fixture workload, real elapsed retention clock')
  console.log('NOT calendar-month T48 acceptance (T48 remains [~])')
  console.log(`action=${action} samples=${state.samples} corpusInserted=${state.corpusSamplesInserted ?? 0} journal=${state.journalPath}`)
  if (reason) console.log(`reason=${reason}`)
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === entry) main()


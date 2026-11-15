import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  appendT48Journal,
  resolveT48JournalPath,
  type T48JournalEntry,
} from '../src/measurement/t48-journal.ts'
import {
  resolveT48MeasurementHome,
  runT48PersistentIncrementalStep,
} from '../src/measurement/t48-persistent-store.ts'

const CADENCE_MS = 24 * 60 * 60 * 1000
const LOCK_LEASE_MS = 10 * 60 * 1000

interface ObservationLock {
  owner: string
  expiresAt: string
}

export interface PendingWallClockObservation {
  runId: string
  startedAt: string
  measurementHome: string
  journalPath: string
}

export interface WallClockObservationState {
  schemaVersion: 1
  startedAt: string
  home: string
  measurementHome: string
  journalPath: string
  samples: number
  lastSampleAt?: string
  corpusSamplesInserted?: number
  pending?: PendingWallClockObservation
}

function statePath(home: string): string {
  return path.join(home, '.ds-agent/measurement/t48-wall-clock-state.json')
}

function lockPath(home: string): string {
  return path.join(home, '.ds-agent/measurement/t48-wall-clock.lock')
}

export function readWallClockState(home: string): WallClockObservationState | undefined {
  const file = statePath(home)
  if (!fs.existsSync(file)) return undefined
  return JSON.parse(fs.readFileSync(file, 'utf8')) as WallClockObservationState
}

export function writeWallClockState(state: WallClockObservationState): void {
  const target = statePath(state.home)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 0)}\n`, 'utf8')
  fs.renameSync(temporary, target)
}

function readLock(file: string): ObservationLock | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ObservationLock
  } catch {
    return undefined
  }
}

function removeLockIfOwned(file: string, owner: string): void {
  if (readLock(file)?.owner === owner) fs.unlinkSync(file)
}

function withObservationLock<T>(
  home: string,
  now: () => Date,
  leaseMs: number,
  work: () => T,
): T {
  const file = lockPath(home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const owner = randomUUID()
  const acquire = (): void => {
    try {
      const descriptor = fs.openSync(file, 'wx')
      try {
        fs.writeFileSync(descriptor, JSON.stringify({
          owner,
          expiresAt: new Date(now().getTime() + leaseMs).toISOString(),
        }))
      } finally {
        fs.closeSync(descriptor)
      }
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const existing = readLock(file)
    if (existing && Date.parse(existing.expiresAt) > now().getTime()) {
      throw new Error(`T48 wall-clock observation already running: ${file}`)
    }
    try {
      fs.unlinkSync(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    acquire()
  }
  acquire()
  try {
    return work()
  } finally {
    removeLockIfOwned(file, owner)
  }
}

function journalHasRun(filePath: string, runId: string): boolean {
  if (!fs.existsSync(filePath)) return false
  return fs.readFileSync(filePath, 'utf8').split('\n').some(line => {
    if (!line.trim()) return false
    try {
      return (JSON.parse(line) as T48JournalEntry).runId === runId
    } catch {
      return false
    }
  })
}

/**
 * Appends one wall-clock observation row when interval elapsed (or force).
 * Persists fixture corpus in a measurement-only child home across invocations; journal rows keep
 * `syntheticWorkload: true` and `syntheticClock: false` (real retention clock only).
 * Does NOT flip T48 to calendar-month complete.
 */
export function runT48WallClockObservation(options: {
  home: string
  journalPath?: string
  minIntervalMs?: number
  force?: boolean
  env?: NodeJS.ProcessEnv
  /** Test-only deterministic fault point for restart reconciliation coverage. */
  testFaultAfter?: 'fixture' | 'fixture-receipt' | 'journal'
  now?: () => Date
  lockLeaseMs?: number
}): { action: 'appended' | 'skipped', reason?: string, state: WallClockObservationState } {
  const now = options.now ?? (() => new Date())
  return withObservationLock(options.home, now, options.lockLeaseMs ?? LOCK_LEASE_MS, () => {
    const minIntervalMs = options.minIntervalMs ?? CADENCE_MS
    const prior = readWallClockState(options.home)
    const nowMs = now().getTime()
    const pending = prior?.pending
    const journalPath = pending?.journalPath ?? options.journalPath ?? resolveT48JournalPath({
      ...(options.env ?? process.env),
      DS_AGENT_HOME: options.home,
    })
    if (
      !pending
      &&
      !options.force
      && prior?.lastSampleAt
      && nowMs - Date.parse(prior.lastSampleAt) < minIntervalMs
    ) {
      return { action: 'skipped', reason: 'interval-not-elapsed', state: prior }
    }

    fs.mkdirSync(options.home, { recursive: true })
    const measurementHome = pending?.measurementHome ?? resolveT48MeasurementHome(options.home)
    const runId = pending?.runId ?? randomUUID()
    const pendingState: WallClockObservationState = prior?.pending
      ? prior
      : {
        schemaVersion: 1,
        startedAt: prior?.startedAt ?? now().toISOString(),
        home: options.home,
        measurementHome,
        journalPath,
        samples: prior?.samples ?? 0,
        lastSampleAt: prior?.lastSampleAt,
        corpusSamplesInserted: prior?.corpusSamplesInserted,
        pending: { runId, startedAt: now().toISOString(), measurementHome, journalPath },
      }
    if (!prior?.pending) writeWallClockState(pendingState)
    const { runId: stepRunId, report, state: corpus } = runT48PersistentIncrementalStep({
      home: measurementHome,
      wallClockMeasurement: true,
      env: options.env,
      runId,
      testFaultAfterInsertionReceipt: options.testFaultAfter === 'fixture-receipt',
    })
    if (stepRunId !== runId) throw new Error('T48 fixture run id changed during observation')
    if (options.testFaultAfter === 'fixture') throw new Error('injected T48 fault after fixture')
    const entry: T48JournalEntry = {
      schemaVersion: 1,
      recordedAt: report.recordedAt,
      syntheticClock: false,
      syntheticWorkload: true,
      runId,
      report,
    }
    if (!journalHasRun(journalPath, runId)) appendT48Journal(journalPath, entry)
    if (options.testFaultAfter === 'journal') throw new Error('injected T48 fault after journal')

    const state: WallClockObservationState = {
      schemaVersion: 1,
      startedAt: pendingState.startedAt,
      home: options.home,
      measurementHome,
      journalPath,
      samples: (prior?.samples ?? 0) + 1,
      lastSampleAt: entry.recordedAt,
      corpusSamplesInserted: corpus.insertedSampleIndices.length,
      pending: undefined,
    }
    writeWallClockState(state)
    return { action: 'appended', state }
  })
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

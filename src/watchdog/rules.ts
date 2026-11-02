import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface WatchdogRules {
  stuckMsDefault: number
  nudgeBeforeFail: boolean
  failAfterFailedJobs: number
  reasons: { stale: string; 'failed-jobs': string; 'goal-drift': string }
  /** Phrases a report can use to admit that it left the ticket's scope. */
  driftMarkers: string[]
}

const fallback: WatchdogRules = {
  stuckMsDefault: 60_000,
  nudgeBeforeFail: true,
  failAfterFailedJobs: 2,
  reasons: {
    stale: 'watchdog: stuck',
    'failed-jobs': 'watchdog: repeated job failures',
    'goal-drift': 'watchdog: report left the ticket scope',
  },
  driftMarkers: ['out of scope', 'unrelated to the ticket', 'different task', 'not what was asked'],
}

export function loadWatchdogRules(path = join(dirname(fileURLToPath(import.meta.url)), 'rules.json')): WatchdogRules {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<WatchdogRules>
    return {
      stuckMsDefault: Number(raw.stuckMsDefault ?? fallback.stuckMsDefault),
      nudgeBeforeFail: raw.nudgeBeforeFail !== false,
      failAfterFailedJobs: Number(raw.failAfterFailedJobs ?? fallback.failAfterFailedJobs),
      reasons: {
        stale: raw.reasons?.stale ?? fallback.reasons.stale,
        'failed-jobs': raw.reasons?.['failed-jobs'] ?? fallback.reasons['failed-jobs'],
        'goal-drift': raw.reasons?.['goal-drift'] ?? fallback.reasons['goal-drift'],
      },
      driftMarkers: Array.isArray(raw.driftMarkers)
        ? raw.driftMarkers.filter((marker): marker is string => typeof marker === 'string' && marker.trim().length > 0)
        : fallback.driftMarkers,
    }
  } catch {
    return { ...fallback, reasons: { ...fallback.reasons } }
  }
}

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface WatchdogRules {
  stuckMsDefault: number
  nudgeBeforeFail: boolean
  failAfterFailedJobs: number
  reasons: { stale: string; 'failed-jobs': string }
}

const fallback: WatchdogRules = {
  stuckMsDefault: 60_000,
  nudgeBeforeFail: true,
  failAfterFailedJobs: 2,
  reasons: {
    stale: 'watchdog: stuck',
    'failed-jobs': 'watchdog: repeated job failures',
  },
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
      },
    }
  } catch {
    return { ...fallback, reasons: { ...fallback.reasons } }
  }
}

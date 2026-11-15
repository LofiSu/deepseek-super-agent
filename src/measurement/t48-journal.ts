import fs from 'node:fs'
import path from 'node:path'

/** Default journal directory for parent-scheduled longitudinal collection (not created at runtime by tests). */
export const DEFAULT_T48_JOURNAL_DIR = '.ds-agent/measurement/t48-journal'

export interface T48JournalEntry {
  schemaVersion: 1
  recordedAt: string
  /**
   * Measurement clock: true when sample timestamps / ages use an injected fixture clock;
   * false when inserts and retention use real elapsed time. Not the same as workload labelling.
   */
  syntheticClock: boolean
  /** Fixture corpus only — never relabelled non-synthetic because wall-clock mode is on. */
  syntheticWorkload: boolean
  runId: string
  report: unknown
}

export function resolveT48JournalPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DS_AGENT_T48_JOURNAL?.trim()
  if (override) return path.resolve(override)
  const dir = env.DS_AGENT_T48_JOURNAL_DIR?.trim() || DEFAULT_T48_JOURNAL_DIR
  const home = env.DS_AGENT_HOME?.trim() || process.cwd()
  return path.join(home, dir, 't48-measurements.jsonl')
}

/** Append one measurement row. Creates parent dirs when missing. */
export function appendT48Journal(filePath: string, entry: T48JournalEntry): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8')
}

export function readT48Journal(filePath: string): T48JournalEntry[] {
  if (!fs.existsSync(filePath)) return []
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(line => line.trim().length > 0)
  return lines.map(line => JSON.parse(line) as T48JournalEntry)
}

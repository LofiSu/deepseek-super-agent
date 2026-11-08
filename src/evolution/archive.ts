import fs from 'node:fs'
import path from 'node:path'
import { stableJsonDigest } from './digest.ts'
import type { EvolutionCandidateRecord, EvolutionRunReport } from './types.ts'

export function evolutionArchiveRoot(home: string): string {
  return path.join(home, 'evolution', 'archive')
}

export function evolutionRunsDir(home: string): string {
  return path.join(home, 'evolution', 'runs')
}

export function writeCandidateArchive(
  archiveDir: string,
  record: EvolutionCandidateRecord,
): string {
  const dir = path.join(archiveDir, record.candidateId)
  fs.mkdirSync(dir, { recursive: true })
  const artifact = path.join(dir, 'candidate.json')
  const body = JSON.stringify(record, null, 2)
  fs.writeFileSync(artifact, body, 'utf8')
  return artifact
}

export function writeRunReport(runsDir: string, report: EvolutionRunReport): string {
  fs.mkdirSync(runsDir, { recursive: true })
  const file = path.join(runsDir, `${report.runId}.json`)
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8')
  return file
}

export function candidateLineageHash(parentId: string | null, strategyDigest: string): string {
  return stableJsonDigest({ parentId, strategyDigest })
}

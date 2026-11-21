import path from 'node:path'
import { stableJsonDigest } from './digest.ts'
import type { EvolutionCandidateRecord, EvolutionRunReport } from './types.ts'
import { writeJsonAtomic } from './io.ts'

export function evolutionArchiveRoot(home: string): string {
  return path.join(home, 'evolution', 'archive')
}

export function evolutionRunsDir(home: string): string {
  return path.join(home, 'evolution', 'runs')
}

export function sealArtifactDigest(record: EvolutionCandidateRecord): string {
  const { artifactDigest: _omit, ...body } = record
  return stableJsonDigest(body)
}

export function writeCandidateArchive(
  archiveDir: string,
  record: EvolutionCandidateRecord,
): { artifactPath: string; artifactDigest: string } {
  const dir = path.join(archiveDir, record.candidateId)
  const artifact = path.join(dir, 'candidate.json')
  const contentDigest = sealArtifactDigest(record)
  const sealed: EvolutionCandidateRecord = { ...record, artifactDigest: contentDigest }
  const body = JSON.stringify(sealed, null, 2)
  if (body.length > 65_536) throw new Error('candidate artifact too large')
  writeJsonAtomic(artifact, sealed)
  return { artifactPath: artifact, artifactDigest: contentDigest }
}

export function writeRunReport(runsDir: string, report: EvolutionRunReport): string {
  const file = path.join(runsDir, `${report.runId}.json`)
  writeJsonAtomic(file, report)
  return file
}

export function candidateLineageHash(parentId: string | null, strategyDigest: string): string {
  return stableJsonDigest({ parentId, strategyDigest })
}

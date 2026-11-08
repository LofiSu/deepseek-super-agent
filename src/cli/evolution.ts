import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { approvePromotion, rollbackPromotion } from '../evolution/promotion.ts'
import { evolutionRunsDir } from '../evolution/archive.ts'
import { runEvolution } from '../evolution/evolve.ts'
import type { EvolutionRunReport } from '../evolution/types.ts'
import { loadPromotedStrategy } from '../evolution/promotion.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function defaultDatasetRoot(): string {
  return path.join(repoRoot, 'test/fixtures/evolution')
}

function loadRunReport(home: string, runId: string): EvolutionRunReport {
  const file = path.join(evolutionRunsDir(home), `${runId}.json`)
  if (!fs.existsSync(file)) throw new Error(`missing run report ${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as EvolutionRunReport
}

export async function runEvolutionCommand(home: string, argv: string[]): Promise<void> {
  const [sub, ...rest] = argv
  if (!sub || sub === 'help' || sub === '--help') {
    console.log(`ds-agent evolution — offline controlled self-evolution (strategy JSON v1)

  pnpm ds-agent evolution run [--home <dir>] [--dataset <dir>]
  pnpm ds-agent evolution approve <runId> <candidateId> [--artifact <path>] [--home <dir>]
  pnpm ds-agent evolution rollback [--home <dir>]
  pnpm ds-agent evolution status [--home <dir>]

  LABEL: default dataset is a redacted fixture under test/fixtures/evolution.
  Never auto-merges or edits production git; promotion writes only under <home>/evolution/.`)
    return
  }

  function homeArg(): string {
    const i = rest.indexOf('--home')
    if (i >= 0 && rest[i + 1]) return rest[i + 1]!
    return home
  }

  const stateHome = homeArg()

  if (sub === 'run') {
    const dIndex = rest.indexOf('--dataset')
    const datasetRoot = dIndex >= 0 && rest[dIndex + 1] ? rest[dIndex + 1]! : defaultDatasetRoot()
    const report = await runEvolution({ home: stateHome, datasetRoot })
    const evaluated = report.candidates.filter(item => item.status === 'evaluated')
    console.log(JSON.stringify({
      runId: report.runId,
      datasetDigest: report.datasetDigest,
      evaluatorDigest: report.evaluatorDigest,
      baseline: report.baseline,
      candidates: report.candidates.map(item => ({
        candidateId: item.candidateId,
        status: item.status,
        scores: item.scores,
        rejectionReason: item.rejectionReason,
        strategyDigest: item.strategyDigest,
      })),
      evaluatedCount: evaluated.length,
      trainFailuresAddressed: evaluated.length > 0,
    }, null, 2))
    return
  }

  if (sub === 'approve') {
    const runId = rest[0]
    const candidateId = rest[1]
    if (!runId || !candidateId) throw new Error('usage: evolution approve <runId> <candidateId>')
    const aIndex = rest.indexOf('--artifact')
    let artifactPath = aIndex >= 0 && rest[aIndex + 1] ? rest[aIndex + 1] : undefined
    const report = loadRunReport(stateHome, runId)
    const record = report.candidates.find(item => item.candidateId === candidateId)
    if (!record) throw new Error(`unknown candidate ${candidateId}`)
    if (!artifactPath) {
      artifactPath = path.join(report.archiveDir, candidateId, 'candidate.json')
    }
    const promotion = approvePromotion({ home: stateHome, runReport: report, candidateId, artifactPath })
    console.log(JSON.stringify({ approved: true, promotion }, null, 2))
    return
  }

  if (sub === 'rollback') {
    const outcome = rollbackPromotion(stateHome)
    console.log(JSON.stringify({ rollback: true, ...outcome }, null, 2))
    return
  }

  if (sub === 'status') {
    const strategy = loadPromotedStrategy(stateHome)
    const runsDir = evolutionRunsDir(stateHome)
    const runs = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter(name => name.endsWith('.json')) : []
    console.log(JSON.stringify({
      promoted: strategy !== null,
      strategy,
      runReports: runs.length,
    }, null, 2))
    return
  }

  throw new Error(`unknown evolution subcommand ${sub}`)
}

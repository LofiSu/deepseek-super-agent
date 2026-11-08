import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { approvePromotion, rollbackPromotion } from '../evolution/promotion.ts'
import { evolutionRunsDir } from '../evolution/archive.ts'
import { runEvolution } from '../evolution/evolve.ts'
import type { EvolutionRunReport } from '../evolution/types.ts'
import { loadPromotedStrategy } from '../evolution/promotion.ts'
import { freezeCandidate } from '../evolution/experiment.ts'
import { runFinalTestOnce } from '../evolution/finalize.ts'
import { loadExperiment } from '../evolution/experiment.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function defaultDatasetRoot(): string {
  return path.join(repoRoot, 'test/fixtures/evolution')
}

function loadRunReport(home: string, runId: string): EvolutionRunReport {
  const file = path.join(evolutionRunsDir(home), `${runId}.json`)
  if (!fs.existsSync(file)) throw new Error(`missing run report ${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as EvolutionRunReport
}

function findRunReportForCandidate(home: string, candidateId: string): EvolutionRunReport {
  const runIndex = restArgvRunFiles(home)
  for (const file of runIndex) {
    const report = JSON.parse(fs.readFileSync(file, 'utf8')) as EvolutionRunReport
    if (report.candidates.some(item => item.candidateId === candidateId)) return report
  }
  throw new Error(`no run report contains candidate ${candidateId}`)
}

function restArgvRunFiles(home: string): string[] {
  const runsDir = evolutionRunsDir(home)
  if (!fs.existsSync(runsDir)) return []
  return fs.readdirSync(runsDir)
    .filter(name => name.endsWith('.json'))
    .map(name => path.join(runsDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
}

export async function runEvolutionCommand(home: string, argv: string[]): Promise<void> {
  const [sub, ...rest] = argv
  if (!sub || sub === 'help' || sub === '--help') {
    console.log(`ds-agent evolution — offline controlled self-evolution (strategy tokens v2)

  pnpm ds-agent evolution run [--home <dir>] [--dataset <dir>] [--selector kl-ucb|simplified-greedy]
  pnpm ds-agent evolution freeze <candidateId> [--home <dir>] [--run <runId>]
  pnpm ds-agent evolution finalize <candidateId> [--home <dir>] [--dataset <dir>]
  pnpm ds-agent evolution approve <runId> <candidateId> [--artifact <path>] [--home <dir>]
  pnpm ds-agent evolution rollback [--home <dir>]
  pnpm ds-agent evolution status [--home <dir>]

  LABEL: tiny fixture dataset; no general quality guarantee.
  Split C (finaltest) is one-shot sealed; never used during search.`)
    return
  }

  function homeArg(): string {
    const i = rest.indexOf('--home')
    if (i >= 0 && rest[i + 1]) return rest[i + 1]!
    return home
  }

  function datasetRoot(): string {
    const dIndex = rest.indexOf('--dataset')
    return dIndex >= 0 && rest[dIndex + 1] ? rest[dIndex + 1]! : defaultDatasetRoot()
  }

  const stateHome = homeArg()

  if (sub === 'run') {
    const selIndex = rest.indexOf('--selector')
    const selector = selIndex >= 0 && rest[selIndex + 1] === 'simplified-greedy'
      ? 'simplified-greedy' as const
      : 'kl-ucb' as const
    const report = await runEvolution({ home: stateHome, datasetRoot: datasetRoot(), selector })
    console.log(JSON.stringify({
      runId: report.runId,
      experimentId: report.experimentId,
      round: report.round,
      datasetDigest: report.datasetDigest,
      evaluatorDigest: report.evaluatorDigest,
      baseline: report.baseline,
      budget: report.budget,
      selector: report.selector,
      candidates: report.candidates.map(item => ({
        candidateId: item.candidateId,
        status: item.status,
        reward: item.reward,
        scores: item.scores,
        rejectionReason: item.rejectionReason,
        strategyDigest: item.strategyDigest,
        directionKey: item.directionKey,
      })),
    }, null, 2))
    return
  }

  if (sub === 'freeze') {
    const candidateId = rest[0]
    if (!candidateId) throw new Error('usage: evolution freeze <candidateId>')
    const runIndex = rest.indexOf('--run')
    const runId = runIndex >= 0 ? rest[runIndex + 1] : undefined
    const runReport = runId
      ? loadRunReport(stateHome, runId)
      : findRunReportForCandidate(stateHome, candidateId)
    const state = freezeCandidate({ home: stateHome, candidateId, runReport })
    console.log(JSON.stringify({ frozen: true, selectedCandidateId: state.selectedCandidateId, phase: state.phase }, null, 2))
    return
  }

  if (sub === 'finalize') {
    const candidateId = rest[0]
    if (!candidateId) throw new Error('usage: evolution finalize <candidateId>')
    const outcome = await runFinalTestOnce({ home: stateHome, datasetRoot: datasetRoot(), candidateId })
    console.log(JSON.stringify({ finalized: true, ...outcome }, null, 2))
    return
  }

  if (sub === 'approve') {
    const runId = rest[0]
    const candidateId = rest[1]
    if (!runId || !candidateId) throw new Error('usage: evolution approve <runId> <candidateId>')
    const aIndex = rest.indexOf('--artifact')
    let artifactPath = aIndex >= 0 && rest[aIndex + 1] ? rest[aIndex + 1] : undefined
    const report = loadRunReport(stateHome, runId)
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
    const experiment = loadExperiment(stateHome)
    const runsDir = evolutionRunsDir(stateHome)
    const runs = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter(name => name.endsWith('.json')) : []
    console.log(JSON.stringify({
      promoted: strategy !== null,
      experiment,
      runReports: runs.length,
    }, null, 2))
    return
  }

  throw new Error(`unknown evolution subcommand ${sub}`)
}

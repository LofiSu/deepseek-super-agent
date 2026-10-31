import fs from 'node:fs'
import path from 'node:path'
import { demoLogDir, messageOf, type DemoSummary } from './lib.ts'
import { runParallelDemo } from './parallel.ts'
import { runSpillMemoryDemo } from './spill-memory.ts'
import { runWatchdogDemo } from './watchdog.ts'

/**
 * Real-channel demo runner.
 *
 *   pnpm demo
 *   pnpm demo -- --only parallel,spill
 *   DS_AGENT_GH_KEEP=1 pnpm demo
 *
 * Every scenario creates/reads real GitHub issues and posts real issue
 * comments. There is no fake IM/GitHub fallback; a missing live model or
 * unauthenticated `gh` CLI fails the run.
 */

type Scenario = { id: string; run: () => Promise<DemoSummary> }

const SCENARIOS: Scenario[] = [
  { id: 'parallel', run: runParallelDemo },
  { id: 'spill', run: runSpillMemoryDemo },
  { id: 'watchdog', run: runWatchdogDemo },
]

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  return process.argv[index + 1]
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function selected(): Scenario[] {
  const only = option('only')
  if (!only) return SCENARIOS
  const ids = only.split(',').map(item => item.trim()).filter(Boolean)
  const unknown = ids.filter(id => !SCENARIOS.some(scenario => scenario.id === id))
  if (unknown.length > 0) throw new Error(`unknown demo(s) ${unknown.join(',')}; known: ${SCENARIOS.map(item => item.id).join(',')}`)
  return SCENARIOS.filter(scenario => ids.includes(scenario.id))
}

async function main(): Promise<void> {
  if (flag('help')) {
    console.log('pnpm demo [--only parallel,spill,watchdog] [--keep]')
    console.log('Real channels only: GitHub issues + comments through gh api, live Magpie/DeepSeek model.')
    process.exit(0)
  }
  if (flag('keep')) process.env.DS_AGENT_GH_KEEP = '1'

  const logDir = demoLogDir()
  fs.mkdirSync(logDir, { recursive: true })
  const startedAt = new Date().toISOString()
  const summaries: DemoSummary[] = []
  const failures: { id: string; error: string }[] = []

  for (const scenario of selected()) {
    console.log(`[demo] === ${scenario.id} ===`)
    try {
      summaries.push(await scenario.run())
    } catch (error) {
      failures.push({ id: scenario.id, error: messageOf(error) })
      console.error(`[demo] ${scenario.id} failed: ${messageOf(error)}`)
      if (flag('fail-fast')) break
    }
  }

  const aggregate = {
    startedAt,
    elapsedMs: Date.now() - Date.parse(startedAt),
    logDir,
    realChannels: {
      github: 'gh api on DS_AGENT_GH_REPO (default LofiSu/deepseek-super-agent)',
      feishu: process.env.FEISHU_APP_ID ? 'configured (FEISHU_APP_ID present)' : 'not configured (no FEISHU_APP_ID)',
    },
    results: summaries.map(summary => ({
      name: summary.name,
      ok: summary.ok,
      runId: summary.runId,
      repo: summary.repo,
      elapsedMs: summary.elapsedMs,
      logFile: summary.logFile,
      proofFile: summary.proofFile,
      checks: summary.checks,
    })),
    failures,
  }
  const summaryFile = path.join(logDir, `run-${startedAt.replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(summaryFile, `${JSON.stringify(aggregate, null, 2)}\n`)
  console.log(`[demo] aggregate ${summaryFile}`)
  console.log(`[demo] ran=${summaries.length} failed=${failures.length}`)

  if (failures.length > 0 || summaries.some(summary => !summary.ok)) process.exitCode = 1
  // A stalled live turn may still hold sockets; all proofs are already on disk.
  process.exit(process.exitCode ?? 0)
}

main().catch(error => {
  console.error(messageOf(error))
  process.exit(1)
})

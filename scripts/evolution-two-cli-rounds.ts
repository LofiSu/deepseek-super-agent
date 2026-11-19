#!/usr/bin/env node
/**
 * Two independent OS CLI processes + LABEL synthetic dataset (temp).
 * Evidence log: /tmp/ds-agent-evolution-cli-demo-<ts>.jsonl
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeSynthDataset } from '../src/evolution/synth-fixture.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const logPath = path.join(os.tmpdir(), `ds-agent-evolution-cli-demo-${Date.now()}.jsonl`)
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-evo-cli-home-'))
const datasetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-evo-synth-'))
writeSynthDataset(datasetRoot)

function append(obj: unknown) {
  fs.appendFileSync(logPath, JSON.stringify(obj) + '\n', 'utf8')
}

function dsAgent(args: string[], roundLabel: string) {
  const cmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const child = spawnSync(cmd, ['ds-agent', 'evolution', ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DS_AGENT_HOME: home,
      CI: 'true',
      DS_AGENT_ALLOW_MOCK_FIXTURE: '1',
    },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  append({
    step: roundLabel,
    parentPid: process.pid,
    childPid: child.pid,
    status: child.status,
    stdout: child.stdout?.trim().slice(0, 6000),
    stderr: child.stderr?.trim().slice(0, 500),
  })
  if (child.status !== 0) {
    throw new Error(`${roundLabel} failed: ${child.stderr ?? child.stdout}`)
  }
  const out = child.stdout ?? ''
  const start = out.indexOf('{')
  const end = out.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return JSON.parse(out.slice(start, end + 1)) as Record<string, unknown>
  }
  return { raw: out }
}

append({ step: 'init', home, datasetRoot, logPath, parentPid: process.pid })

const r1 = dsAgent([
  'run',
  '--dataset',
  datasetRoot,
  '--selector',
  'simplified-greedy',
  '--no-stop-on-success',
  '--max-candidates-this-run',
  '1',
], 'round1_cli_process') as { candidates?: Array<Record<string, unknown>>; runId?: string }

const r2 = dsAgent([
  'run',
  '--dataset',
  datasetRoot,
  '--selector',
  'policy-memory',
], 'round2_cli_process') as { candidates?: Array<Record<string, unknown>>; runId?: string }

append({
  step: 'round_decisions',
  round1: r1.candidates,
  round2: r2.candidates,
})

if ((r2.candidates?.length ?? 0) === 0) {
  throw new Error('round2 produced no candidates; memory lesson did not change search')
}

function pickWinner(...reports: Array<{ candidates?: Array<{ candidateId: string; status: string; reward: string }>; runId?: string }>) {
  for (const report of reports) {
    if (!report?.candidates) continue
    const winner = report.candidates.find(c => c.status === 'evaluated' && c.reward === 'success')
      ?? report.candidates.find(c => c.status === 'evaluated')
    if (winner) return { winner, report }
  }
  return null
}

const picked = pickWinner(r2 as Parameters<typeof pickWinner>[0], r1 as Parameters<typeof pickWinner>[0])
if (!picked) throw new Error('no evaluated candidate for freeze')
const { winner, report: winReport } = picked

dsAgent(['freeze', winner.candidateId, '--run', winReport.runId!], 'freeze_cli_process')
const fin = dsAgent(['finalize', winner.candidateId, '--dataset', datasetRoot], 'finalize_cli_process')

try {
  dsAgent(['finalize', winner.candidateId, '--dataset', datasetRoot], 'finalize_retry_rejected')
} catch (error) {
  append({ step: 'finalize_retry_rejected', error: String(error) })
}

try {
  dsAgent(['run', '--dataset', datasetRoot], 'search_after_freeze_rejected')
} catch (error) {
  append({ step: 'search_after_freeze_rejected', error: String(error) })
}

const prevGate = process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE
process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE = '1'
try {
  const approve = dsAgent(['approve', winReport.runId!, winner.candidateId], 'approve_cli_process')
  const status = dsAgent(['status'], 'status_promoted')
  dsAgent(['rollback'], 'rollback_cli_process')
  const statusAfter = dsAgent(['status'], 'status_after_rollback')
  append({ step: 'promotion_cycle', approve, status, statusAfter })
} finally {
  if (prevGate === undefined) delete process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE
  else process.env.DS_AGENT_USE_PROMOTED_DELIVER_GATE = prevGate
}

append({
  step: 'summary',
  round1Count: r1.candidates?.length ?? 0,
  round2Count: r2.candidates?.length ?? 0,
  round1First: r1.candidates?.[0],
  round2First: r2.candidates?.[0],
  winner: winner.candidateId,
  parentHonesty: 'baseline_immutable',
  finaltest: fin,
  logPath,
})

console.log(JSON.stringify({
  ok: true,
  home,
  logPath,
  round1: { count: r1.candidates?.length, first: r1.candidates?.[0] },
  round2: { count: r2.candidates?.length, first: r2.candidates?.[0] },
}, null, 2))

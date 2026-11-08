#!/usr/bin/env node
/**
 * Two independent OS CLI processes for evolution search rounds (fixture LABEL).
 * Evidence log: /tmp/ds-agent-evolution-cli-demo-<ts>.jsonl (outside repo)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const logPath = path.join(os.tmpdir(), `ds-agent-evolution-cli-demo-${Date.now()}.jsonl`)
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-evo-cli-home-'))
const datasetRoot = path.join(repoRoot, 'test/fixtures/evolution')

function append(obj) {
  fs.appendFileSync(logPath, JSON.stringify(obj) + '\n', 'utf8')
}

function dsAgent(args, roundLabel) {
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
    stdout: child.stdout?.trim().slice(0, 4000),
    stderr: child.stderr?.trim().slice(0, 500),
  })
  if (child.status !== 0) {
    throw new Error(`${roundLabel} failed: ${child.stderr ?? child.stdout}`)
  }
  const out = child.stdout ?? ''
  const start = out.indexOf('{')
  const end = out.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return JSON.parse(out.slice(start, end + 1))
  }
  return { raw: out }
}

append({ step: 'init', home, datasetRoot, logPath, parentPid: process.pid })

const r1 = dsAgent(['run', '--dataset', datasetRoot], 'round1_cli_process')
const r2 = dsAgent(['run', '--dataset', datasetRoot, '--selector', 'kl-ucb'], 'round2_cli_process')

function pickWinner(...reports) {
  for (const report of reports) {
    if (!report?.candidates) continue
    const winner = report.candidates.find(c => c.status === 'evaluated' && c.reward === 'success')
      ?? report.candidates.find(c => c.status === 'evaluated')
    if (winner) return { winner, report }
  }
  return null
}

const picked = pickWinner(r2, r1)
if (!picked) throw new Error('no evaluated candidate for freeze')
const { winner, report: winReport } = picked

const freeze = dsAgent([
  'freeze',
  winner.candidateId,
  '--run',
  winReport.runId,
], 'freeze_cli_process')

const fin = dsAgent([
  'finalize',
  winner.candidateId,
  '--dataset',
  datasetRoot,
], 'finalize_cli_process')

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

append({
  step: 'summary',
  round1Candidates: r1?.candidates?.length ?? 0,
  round2Candidates: r2?.candidates?.length ?? 0,
  winner: winner.candidateId,
  freeze,
  finaltest: fin,
  logPath,
})

console.log(JSON.stringify({ ok: true, home, logPath }, null, 2))

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DeliverGateStrategyV1, EvolutionEvalCase, SplitScore } from './types.ts'
import type { EvolutionBudget } from './types.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const childScript = path.join(repoRoot, 'scripts/evolution-eval-child.mjs')
const tsxCli = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

export interface IsolatedEvalResult {
  ok: boolean
  score?: SplitScore
  error?: string
  timedOut?: boolean
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, filePath)
}

/**
 * Run scoring in a separate OS process with temp files only (strategy JSON v1 — no
 * untrusted code execution in the child).
 */
export async function isolatedEvaluateSplit(
  workDir: string,
  strategy: DeliverGateStrategyV1,
  splitName: 'train' | 'validation',
  cases: EvolutionEvalCase[],
  budget: Pick<EvolutionBudget, 'evalTimeoutMs'>,
): Promise<IsolatedEvalResult> {
  const evalDir = path.join(workDir, 'eval', `${splitName}-${Date.now()}`)
  fs.mkdirSync(evalDir, { recursive: true })
  const strategyPath = path.join(evalDir, 'strategy.json')
  const splitPath = path.join(evalDir, 'split.json')
  writeJsonAtomic(strategyPath, strategy)
  writeJsonAtomic(splitPath, { cases })

  return new Promise(resolve => {
    const childArgs = fs.existsSync(tsxCli)
      ? [tsxCli, childScript, strategyPath, splitPath, splitName]
      : [childScript, strategyPath, splitPath, splitName]
    const child = spawn(process.execPath, childArgs, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        // Do not pass secrets into the child; offline evaluator only.
        DS_AGENT_API_KEY: '',
        DS_AGENT_API_BASE: '',
        HOME: evalDir,
        TMPDIR: evalDir,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ ok: false, timedOut: true, error: 'eval_timeout' })
    }, budget.evalTimeoutMs)
    child.on('close', code => {
      clearTimeout(timer)
      const line = stdout.trim().split('\n').filter(Boolean).at(-1) ?? ''
      try {
        const parsed = JSON.parse(line) as { ok: boolean; score?: SplitScore; error?: string }
        if (!parsed.ok) {
          resolve({ ok: false, error: parsed.error ?? `child_exit_${code} ${stderr.slice(0, 200)}` })
          return
        }
        if (!parsed.score || !Number.isFinite(parsed.score.accuracy)) {
          resolve({ ok: false, error: 'malformed_score' })
          return
        }
        resolve({ ok: true, score: parsed.score })
      } catch {
        resolve({ ok: false, error: `malformed_child_output code=${code}` })
      }
    })
    child.on('error', err => {
      clearTimeout(timer)
      resolve({ ok: false, error: err.message })
    })
  })
}

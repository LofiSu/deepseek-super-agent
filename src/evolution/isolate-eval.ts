import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { resolveEvaluatorArtifacts } from './evaluator-identity.ts'
import type { DeliverGateStrategyV1, EvolutionEvalCase, SplitScore } from './types.ts'
import { DEFAULT_EVOLUTION_BUDGET, type EvolutionBudget } from './types.ts'

// Resolved for the current layout: repo scripts/ in a checkout, dist/scripts/
// in a published package. The published child runs with plain node.
const { repoRoot, childScript } = resolveEvaluatorArtifacts()
const tsxCli = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

export interface IsolatedEvalResult {
  ok: boolean
  score?: SplitScore
  error?: string
  timedOut?: boolean
}

export interface EvalChildPaths {
  strategyPath: string
  splitPath: string
  splitName: string
}

/**
 * Arguments after `process.execPath` for the evaluator child.
 *
 * Load tsx with `--import` so the evaluator is a direct child of this process.
 * The tsx CLI (`node node_modules/tsx/dist/cli.mjs`) spawns a second Node
 * process for the script, so killing the CLI on timeout leaves the evaluator
 * grandchild running. `--import tsx` keeps the script in the spawned process,
 * and SIGKILL then ends it.
 */
export function evalChildArgs(paths: EvalChildPaths, hasTsxCli = fs.existsSync(tsxCli)): string[] {
  return hasTsxCli
    ? ['--import', 'tsx', childScript, paths.strategyPath, paths.splitPath, paths.splitName]
    : [childScript, paths.strategyPath, paths.splitPath, paths.splitName]
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
  splitName: 'train' | 'validation' | 'finaltest',
  cases: EvolutionEvalCase[],
  budget: Pick<EvolutionBudget, 'evalTimeoutMs' | 'maxOutputBytes'>,
): Promise<IsolatedEvalResult> {
  const maxOutputBytes = budget.maxOutputBytes ?? DEFAULT_EVOLUTION_BUDGET.maxOutputBytes ?? 65_536
  const evalDir = path.join(workDir, 'eval', `${splitName}-${Date.now()}`)
  fs.mkdirSync(evalDir, { recursive: true })
  const strategyPath = path.join(evalDir, 'strategy.json')
  const splitPath = path.join(evalDir, 'split.json')
  writeJsonAtomic(strategyPath, strategy)
  writeJsonAtomic(splitPath, { cases })

  return new Promise(resolve => {
    const childArgs = evalChildArgs({ strategyPath, splitPath, splitName })
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
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (result: IsolatedEvalResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }
    // Cap each stream independently: a noisy or replaced child must not grow
    // parent memory without bound, and truncated output is never a score.
    const append = (stream: 'stdout' | 'stderr', current: string, chunk: unknown): string => {
      if (settled) return current
      const next = current + String(chunk)
      if (next.length <= maxOutputBytes) return next
      child.kill('SIGKILL')
      settle({ ok: false, error: `eval_output_limit: ${stream} exceeded ${maxOutputBytes} bytes` })
      return next.slice(0, maxOutputBytes)
    }
    child.stdout.on('data', chunk => { stdout = append('stdout', stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = append('stderr', stderr, chunk) })
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ ok: false, timedOut: true, error: 'eval_timeout' })
    }, budget.evalTimeoutMs)
    child.on('close', code => {
      if (settled) return
      const line = stdout.trim().split('\n').filter(Boolean).at(-1) ?? ''
      try {
        const parsed = JSON.parse(line) as { ok: boolean; score?: SplitScore; error?: string }
        if (!parsed.ok) {
          settle({ ok: false, error: parsed.error ?? `child_exit_${code} ${stderr.slice(0, 200)}` })
          return
        }
        if (!parsed.score || !Number.isFinite(parsed.score.accuracy)) {
          settle({ ok: false, error: 'malformed_score' })
          return
        }
        settle({ ok: true, score: parsed.score })
      } catch {
        settle({ ok: false, error: `malformed_child_output code=${code}` })
      }
    })
    child.on('error', err => {
      settle({ ok: false, error: err.message })
    })
  })
}

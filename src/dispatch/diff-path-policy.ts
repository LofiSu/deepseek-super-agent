import { spawnSync } from 'node:child_process'
import { UserError } from '../shared/errors.ts'

export type ImplementPathMode = 'github_fix' | 'rsi_implement'

const GIT_LOCAL_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } as const

/** Enforced at publish; Claude prompt is guidance only. */
const FORBIDDEN_PATH_RULES: readonly { re: RegExp; reason: string }[] = [
  { re: /^src\/dispatch\/admission\.ts$/, reason: 'admission' },
  { re: /^src\/dispatch\/config\.ts$/, reason: 'dispatch trust config' },
  { re: /^src\/dispatch\/webhook-verify\.ts$/, reason: 'webhook ingress' },
  { re: /^src\/ingress\/filter\.ts$/, reason: 'ingress filter' },
  { re: /github-dispatch\.json$/, reason: 'dispatch owner config' },
  { re: /^src\/env\/seccomp\.ts$/, reason: 'sandbox policy' },
  { re: /sandbox-read-isolation/i, reason: 'sandbox policy' },
  { re: /bash-allow-network|bash-policy/i, reason: 'bash network policy' },
  { re: /^src\/vault\//, reason: 'vault' },
  { re: /^src\/channels\/vault/i, reason: 'vault' },
  { re: /credential-sentinel/i, reason: 'credential store' },
  { re: /^src\/env\/git-publish\.ts$/, reason: 'publish intermediary' },
  { re: /^\.github\//, reason: 'github workflows' },
  { re: /memory-recall-eval\.test\.ts$/, reason: 'eval thresholds' },
  { re: /^src\/dispatch\/(implementer|job-runner|diff-path-policy|holdout)\.ts$/, reason: 'dispatch publish path' },
]

const RSI_EXTRA_FORBIDDEN: readonly { re: RegExp; reason: string }[] = [
  { re: /^package\.json$/, reason: 'dependency manifest' },
  { re: /^pnpm-lock\.yaml$/, reason: 'lockfile' },
]

export function changedPathsSinceRef(workspace: string, baseHead: string): string[] {
  const r = spawnSync('git', ['diff', '--name-only', baseHead], {
    cwd: workspace,
    encoding: 'utf8',
    env: GIT_LOCAL_ENV,
  })
  if (r.status !== 0) {
    throw new UserError('implementer: could not diff against baseline ref')
  }
  return (r.stdout ?? '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
}

function matchForbidden(rel: string, rules: readonly { re: RegExp; reason: string }[]): string | undefined {
  for (const rule of rules) {
    if (rule.re.test(rel)) return rule.reason
  }
  return undefined
}

function isDocsOrPromptOnly(paths: readonly string[]): boolean {
  if (paths.length === 0) return false
  return paths.every(p => p.startsWith('docs/') || p.startsWith('prompts/') || p.endsWith('.md'))
}

export function assertImplementerDiffPolicy(
  workspace: string,
  baseHead: string,
  mode: ImplementPathMode,
): void {
  const paths = changedPathsSinceRef(workspace, baseHead)
  for (const rel of paths) {
    const why = matchForbidden(rel, FORBIDDEN_PATH_RULES)
    if (why) {
      throw new UserError(
        `implementer: refused publish — forbidden path change (${why}): ${rel}`,
      )
    }
    if (mode === 'rsi_implement') {
      const rsiWhy = matchForbidden(rel, RSI_EXTRA_FORBIDDEN)
      if (rsiWhy) {
        throw new UserError(
          `implementer: refused RSI publish — forbidden path (${rsiWhy}): ${rel}`,
        )
      }
    }
  }
  if (mode === 'rsi_implement' && isDocsOrPromptOnly(paths)) {
    throw new UserError(
      'implementer: refused RSI publish — diff only touches docs/prompts; not a code gap',
    )
  }
}


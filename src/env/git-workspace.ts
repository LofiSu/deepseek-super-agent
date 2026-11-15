import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { UserError } from '../shared/errors.ts'

const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } as const

export const PEANUT_BRANCH_PREFIX = 'peanut/'

/** Host credential paths to overlay in Linux bwrap (after `--ro-bind / /`). */
export function defaultCredentialHidePaths(home = os.homedir()): string[] {
  const roots = [
    path.join(home, '.config', 'gh'),
    path.join(home, '.ssh'),
    path.join(home, '.git-credentials'),
    path.join(home, '.netrc'),
    path.join(home, '.config', 'git'),
    path.join(home, '.npmrc'),
    path.join(home, '.claude'),
    path.join(home, '.config', 'claude'),
    '/workspace/ds-agent-notify-secrets',
  ]
  return roots.filter(p => {
    try {
      return fs.existsSync(p)
    } catch {
      return false
    }
  })
}

/** Drop hide targets that lie inside a writable workspace root. */
export function hidePathsForWorkspace(
  hidePaths: readonly string[],
  writableRoots: readonly string[],
): string[] {
  const roots = writableRoots.map(r => {
    try {
      return fs.realpathSync(r)
    } catch {
      return path.resolve(r)
    }
  })
  return hidePaths.filter(hide => {
    let resolved: string
    try {
      resolved = fs.realpathSync(hide)
    } catch {
      resolved = path.resolve(hide)
    }
    return !roots.some(root => resolved === root || resolved.startsWith(`${root}${path.sep}`))
  })
}

export function workspaceDirIsEmpty(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0
  } catch {
    return false
  }
}

/** Standalone clone into an empty worker directory (never `git worktree add`). */
export function seedWorkspaceCheckout(workspace: string, sourceRepo: string): void {
  if (!workspaceDirIsEmpty(workspace)) return
  fs.mkdirSync(workspace, { recursive: true })
  const clone = spawnSync(
    'git',
    ['clone', '--no-hardlinks', '--', sourceRepo, workspace],
    {
      stdio: 'ignore',
      env: { ...process.env, ...GIT_ENV },
    },
  )
  const rollbackSeed = (): void => {
    try {
      fs.rmSync(workspace, { recursive: true, force: true })
    } catch {
      /* cleanup best-effort */
    }
  }
  if (clone.status !== 0) {
    rollbackSeed()
    throw new UserError(`git clone failed (exit ${clone.status ?? 1})`)
  }
  try {
    assertGitCommonDirInsideWorkspace(workspace)
  } catch (error) {
    rollbackSeed()
    throw error
  }
}

function gitCommonDir(workspace: string): string {
  const out = execSync('git rev-parse --git-common-dir', {
    cwd: workspace,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, ...GIT_ENV },
  }).trim()
  return path.resolve(workspace, out)
}

function realGitCommonDir(workspace: string): string {
  const common = gitCommonDir(workspace)
  if (fs.existsSync(common)) {
    return fs.realpathSync(common)
  }
  const gitDir = path.join(workspace, '.git')
  if (fs.existsSync(gitDir) && fs.lstatSync(gitDir).isFile()) {
    const gitfile = fs.readFileSync(gitDir, 'utf8').trim()
    const m = /^gitdir:\s*(.+)$/m.exec(gitfile)
    if (m?.[1]) {
      const linked = path.resolve(workspace, m[1].trim())
      if (fs.existsSync(linked)) return fs.realpathSync(linked)
    }
  }
  throw new UserError('workspace is not a git checkout')
}

/** Refuse linked worktrees whose object database lives outside the workspace. */
export function assertGitCommonDirInsideWorkspace(workspace: string): void {
  let wsReal: string
  try {
    wsReal = fs.realpathSync(workspace)
  } catch {
    throw new UserError('workspace path is not accessible')
  }
  execSync('git rev-parse --is-inside-work-tree', {
    cwd: workspace,
    stdio: 'ignore',
    env: { ...process.env, ...GIT_ENV },
  })
  const common = realGitCommonDir(workspace)
  if (common !== wsReal && !common.startsWith(`${wsReal}${path.sep}`)) {
    throw new UserError(
      'publish refused: workspace git directory is outside the worker workspace',
    )
  }
}

export function currentBranch(workspace: string): string | undefined {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: workspace,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ...GIT_ENV },
    }).trim()
    return branch && branch !== 'HEAD' ? branch : undefined
  } catch {
    return undefined
  }
}

const PROTECTED_SLUGS = new Set(['main', 'master'])
const PEANUT_MAIN = `${PEANUT_BRANCH_PREFIX}main`

/** Shell-free slug segment after optional peanut/ prefix (no peanut/main). */
function assertSlugSegment(segment: string): void {
  if (!segment || segment.endsWith('/')) {
    throw new UserError('publish refused: invalid branch slug')
  }
  if (segment.includes('..') || segment.startsWith('refs/') || /[\x00-\x1f]/.test(segment)) {
    throw new UserError('publish refused: invalid branch slug')
  }
  if (/[\s:]/.test(segment) || segment.startsWith('-')) {
    throw new UserError('publish refused: invalid branch slug')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(segment)) {
    throw new UserError('publish refused: invalid branch slug')
  }
  const leaf = segment.split('/').filter(Boolean).pop() ?? segment
  if (PROTECTED_SLUGS.has(leaf) || PROTECTED_SLUGS.has(segment)) {
    throw new UserError('publish refused: branch slug resolves to a protected ref')
  }
}

function assertPeanutFeatureBranch(branch: string): void {
  if (!branch.startsWith(PEANUT_BRANCH_PREFIX)) {
    throw new UserError('publish refused: only peanut/ feature branches may be published')
  }
  if (branch === PEANUT_MAIN || branch === 'peanut/master') {
    throw new UserError('publish refused: only peanut/ feature branches may be published')
  }
  const tail = branch.slice(PEANUT_BRANCH_PREFIX.length)
  if (!tail) {
    throw new UserError('publish refused: only peanut/ feature branches may be published')
  }
  assertSlugSegment(tail)
}

/**
 * When `slug` is set it is authoritative (normalized under `peanut/`).
 * When omitted, `head` must already be a valid `peanut/*` feature branch.
 */
export function normalizePeanutBranch(slug: string | undefined, head: string | undefined): string {
  const raw = (slug ?? '').trim()
  if (raw) {
    if (raw.startsWith('/') || raw.includes('..') || raw.startsWith('refs/') || /[\x00-\x1f]/.test(raw)) {
      throw new UserError('publish refused: invalid branch slug')
    }
    const base = raw.replace(/^peanut\//, '').split('/').filter(Boolean).join('/')
    if (!base) throw new UserError('publish refused: invalid branch slug')
    assertSlugSegment(base)
    const branch = `${PEANUT_BRANCH_PREFIX}${base}`
    assertPeanutFeatureBranch(branch)
    return branch
  }
  if (!head?.startsWith(PEANUT_BRANCH_PREFIX)) {
    throw new UserError('publish_feature_pr needs branch slug or an existing peanut/ branch')
  }
  assertPeanutFeatureBranch(head)
  return head
}


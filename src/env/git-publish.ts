import { spawn } from 'node:child_process'
import { execSync } from 'node:child_process'
import type { GithubRepoRef } from '../channels/github-source.ts'
import type { GhRun } from '../channels/github-source.ts'
import { runGh } from '../channels/github-source.ts'
import { UserError } from '../shared/errors.ts'
import {
  assertGitCommonDirInsideWorkspace,
  currentBranch,
  normalizePeanutBranch,
} from './git-workspace.ts'

export interface GitRunResult {
  code: number
  stdout: string
  stderr: string
}

export interface GitRun {
  (args: string[], opts: { cwd: string }): Promise<GitRunResult>
}

export const runGit: GitRun = (args, opts) => new Promise((resolve, reject) => {
  const child = spawn('git', args, {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer | string) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk: Buffer | string) => { stderr += String(chunk) })
  child.on('error', error => reject(new Error(`cannot run git: ${error.message}`)))
  child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
})

export interface PublishFeaturePrInput {
  workerId: string
  title: string
  body?: string
  branch?: string
}

export interface PublishFeaturePrResult {
  url: string
  number: number
  branch: string
  remote: string
}

export interface FeaturePrPublisherOptions {
  repo: GithubRepoRef
  workspace: (workerId: string) => string
  /** Test override: `git push` destination instead of the default GitHub remote URL. */
  pushRemote?: string
  git?: GitRun
  gh?: GhRun
}

/**
 * Host-side publish path for Peanut workers. Fixed repo, peanut/ prefix only,
 * PR to main — no merge, force, tags, or arbitrary gh argv from the model.
 */
export class FeaturePrPublisher {
  private readonly repo: GithubRepoRef
  private readonly workspace: (workerId: string) => string
  private readonly pushRemote: string
  private readonly git: GitRun
  private readonly gh: GhRun

  constructor(options: FeaturePrPublisherOptions) {
    this.repo = options.repo
    this.workspace = options.workspace
    this.pushRemote = options.pushRemote ?? `https://github.com/${options.repo.full}.git`
    this.git = options.git ?? runGit
    this.gh = options.gh ?? runGh
  }

  async publish(input: PublishFeaturePrInput): Promise<PublishFeaturePrResult> {
    const title = input.title?.trim()
    if (!title) throw new UserError('publish_feature_pr needs title')
    const ws = this.workspace(input.workerId)
    assertGitCommonDirInsideWorkspace(ws)
    const head = currentBranch(ws)
    const branch = normalizePeanutBranch(input.branch, head)
    await this.ensureBranch(ws, branch)
    const push = await this.git(
      ['push', this.pushRemote, `HEAD:${branch}`],
      { cwd: ws },
    )
    if (push.code !== 0) {
      throw new UserError(`git push failed (exit ${push.code}): ${push.stderr.trim().slice(0, 400)}`)
    }
    const remote = `${this.repo.owner}/${this.repo.repo}`
    const { number, url } = await this.upsertPullRequest(branch, title, input.body)
    return { url, number, branch, remote }
  }

  private async ensureBranch(ws: string, branch: string): Promise<void> {
    const head = currentBranch(ws)
    if (head !== branch) {
      const co = await this.git(['checkout', '-B', branch], { cwd: ws })
      if (co.code !== 0) {
        throw new UserError(`git checkout failed: ${co.stderr.trim().slice(0, 300)}`)
      }
    }
    try {
      execSync('git rev-parse HEAD', {
        cwd: ws,
        stdio: 'ignore',
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
      })
    } catch {
      throw new UserError('publish refused: workspace has no commits to publish')
    }
  }

  private async upsertPullRequest(
    headBranch: string,
    title: string,
    body?: string,
  ): Promise<{ number: number; url: string }> {
    let listOut: string
    try {
      listOut = await this.gh([
        'pr', 'list',
        '--repo', this.repo.full,
        '--head', headBranch,
        '--base', 'main',
        '--state', 'open',
        '--json', 'number,url',
        '--limit', '1',
      ])
    } catch (error) {
      throw new UserError(`gh pr list failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const items = listOut.trim() ? (JSON.parse(listOut) as { number: number; url: string }[]) : []
    if (items[0]) {
      const number = items[0].number
      const url = items[0].url
      const editArgs = ['pr', 'edit', String(number), '--repo', this.repo.full, '--title', title]
      if (body?.trim()) editArgs.push('--body', body.trim())
      await this.gh(editArgs)
      return { number, url }
    }
    const createArgs = [
      'pr', 'create',
      '--repo', this.repo.full,
      '--base', 'main',
      '--head', headBranch,
      '--title', title,
    ]
    if (body?.trim()) createArgs.push('--body', body.trim())
    let createOut: string
    try {
      createOut = await this.gh(createArgs)
    } catch (error) {
      throw new UserError(`gh pr create failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const url = createOut.trim().split(/\s+/).pop() ?? ''
    if (!url) throw new UserError('gh pr create returned no URL')
    const viewOut = await this.gh(['pr', 'view', url, '--repo', this.repo.full, '--json', 'number,url'])
    const parsed = JSON.parse(viewOut) as { number: number; url: string }
    return { number: parsed.number, url: parsed.url || url }
  }
}


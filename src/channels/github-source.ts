import { spawn } from 'node:child_process'
import type { Trigger } from '../shared/types.ts'
import type { OutboundAdapter } from './outbox-adapter.ts'
import type { OutboxRow } from '../shared/types.ts'

/**
 * Real GitHub source and outbox adapter.
 *
 * The source reads a real issue plus its comments through the GitHub REST API
 * (`gh api`, authenticated by the operator's `gh auth login`). Nothing here
 * synthesizes an issue body: trigger text is the API's `title`/`body`/comment
 * fields. The outbox adapter posts the rendered Router reply back as a real
 * issue comment and records the provider comment id.
 */

export const DEFAULT_GITHUB_REPO = 'LofiSu/deepseek-super-agent'

export interface GithubRepoRef {
  owner: string
  repo: string
  full: string
}

export function parseRepo(full: string): GithubRepoRef {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(full.trim())
  if (!match) throw new Error(`GitHub repo must be owner/name, got "${full}"`)
  return { owner: match[1]!, repo: match[2]!, full: `${match[1]}/${match[2]}` }
}

export function githubRepoFromEnv(env: NodeJS.ProcessEnv = process.env): GithubRepoRef {
  return parseRepo(env.DS_AGENT_GH_REPO?.trim() || DEFAULT_GITHUB_REPO)
}

export interface GithubUser {
  id?: number
  login?: string
  type?: string
}

export interface GithubIssue {
  id: number
  number: number
  title: string
  body: string | null
  state?: string
  html_url?: string
  created_at: string
  updated_at?: string
  user?: GithubUser | null
}

export interface GithubComment {
  id: number
  body: string | null
  html_url?: string
  created_at: string
  user?: GithubUser | null
}

export interface GithubApi {
  createIssue(input: { title: string; body: string; labels?: string[] }): Promise<GithubIssue>
  getIssue(number: number): Promise<GithubIssue>
  updateIssue(number: number, patch: { state?: 'open' | 'closed'; body?: string }): Promise<GithubIssue>
  listIssueComments(number: number): Promise<GithubComment[]>
  createIssueComment(number: number, body: string): Promise<GithubComment>
  getIssueComment(commentId: number): Promise<GithubComment>
  request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>
}

export interface GhRun {
  (args: string[], input?: string): Promise<string>
}

/** Spawn `gh` without a shell so comment bodies never go through command quoting. */
export const runGh: GhRun = (args, input) => new Promise((resolve, reject) => {
  const child = spawn('gh', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer | string) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk: Buffer | string) => { stderr += String(chunk) })
  child.on('error', error => reject(new Error(`cannot run gh: ${error.message}`)))
  child.on('close', code => {
    if (code === 0) {
      resolve(stdout)
      return
    }
    reject(new Error(`gh ${args.join(' ')} failed (exit ${code}): ${(stderr || stdout).trim().slice(0, 800)}`))
  })
  child.stdin.end(input ?? '')
})

/** GitHub REST adapter backed by the `gh` CLI's authenticated token. */
export class GhCliApi implements GithubApi {
  constructor(
    readonly repo: GithubRepoRef,
    private readonly gh: GhRun = runGh,
  ) {}

  async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const method = init.method ?? 'GET'
    const args = [
      'api',
      '--method',
      method,
      path.replace(/^\//, ''),
      '--header',
      'Accept: application/vnd.github+json',
      '--header',
      'X-GitHub-Api-Version: 2022-11-28',
    ]
    let input: string | undefined
    if (init.body !== undefined) {
      args.push('--input', '-')
      input = JSON.stringify(init.body)
    }
    const out = await this.gh(args, input)
    if (!out.trim()) return undefined as T
    return JSON.parse(out) as T
  }

  createIssue(input: { title: string; body: string; labels?: string[] }): Promise<GithubIssue> {
    return this.request(`repos/${this.repo.full}/issues`, {
      method: 'POST',
      body: { title: input.title, body: input.body, ...(input.labels ? { labels: input.labels } : {}) },
    })
  }

  getIssue(number: number): Promise<GithubIssue> {
    return this.request(`repos/${this.repo.full}/issues/${number}`)
  }

  updateIssue(number: number, patch: { state?: 'open' | 'closed'; body?: string }): Promise<GithubIssue> {
    return this.request(`repos/${this.repo.full}/issues/${number}`, { method: 'PATCH', body: patch })
  }

  listIssueComments(number: number): Promise<GithubComment[]> {
    return this.request(`repos/${this.repo.full}/issues/${number}/comments?per_page=100`)
  }

  createIssueComment(number: number, body: string): Promise<GithubComment> {
    return this.request(`repos/${this.repo.full}/issues/${number}/comments`, {
      method: 'POST',
      body: { body },
    })
  }

  getIssueComment(commentId: number): Promise<GithubComment> {
    return this.request(`repos/${this.repo.full}/issues/comments/${commentId}`)
  }
}

export function issueThread(number: number): string {
  return `issue:${number}`
}

function addressedIn(text: string): 'mention' | undefined {
  return /@ds-agent\b/i.test(text) ? 'mention' : undefined
}

function actorOf(user: GithubUser | null | undefined): { source: string; id: string } {
  return { source: 'github', id: user?.login ?? 'unknown' }
}

function humanOf(user: GithubUser | null | undefined): boolean {
  return user?.type !== 'Bot'
}

function channelOf(repo: GithubRepoRef, issue: GithubIssue) {
  return {
    source: 'github',
    thread: issueThread(issue.number),
    address: {
      provider: 'github',
      repo: repo.full,
      issue: String(issue.number),
      kind: 'issue',
      ...(issue.html_url ? { url: issue.html_url } : {}),
    },
  }
}

/** Real issue body as a Trigger. The title is prepended for structured density. */
export function githubIssueTrigger(repo: GithubRepoRef, issue: GithubIssue): Trigger {
  const body = issue.body ?? ''
  const text = issue.title ? `${issue.title}\n\n${body}` : body
  return {
    id: `gh_issue_${issue.id}_body`,
    source: 'github',
    threads: [{ source: 'github', id: issueThread(issue.number) }],
    actor: actorOf(issue.user),
    human: humanOf(issue.user),
    addressed: addressedIn(text),
    at: issue.created_at,
    text,
    channel: channelOf(repo, issue),
    meta: {
      provider: 'github',
      repo: repo.full,
      issue: issue.number,
      issueId: issue.id,
      kind: 'issue',
      title: issue.title,
      ...(issue.html_url ? { url: issue.html_url } : {}),
    },
  }
}

/** Real issue comment as a Trigger. */
export function githubCommentTrigger(repo: GithubRepoRef, issue: GithubIssue, comment: GithubComment): Trigger {
  const text = comment.body ?? ''
  return {
    id: `gh_comment_${comment.id}`,
    source: 'github',
    threads: [{ source: 'github', id: issueThread(issue.number) }],
    actor: actorOf(comment.user),
    human: humanOf(comment.user),
    addressed: addressedIn(text),
    at: comment.created_at,
    text,
    channel: channelOf(repo, issue),
    meta: {
      provider: 'github',
      repo: repo.full,
      issue: issue.number,
      issueId: issue.id,
      kind: 'comment',
      commentId: comment.id,
      ...(comment.html_url ? { url: comment.html_url } : {}),
    },
  }
}

export interface GithubPull {
  issue: GithubIssue
  comments: GithubComment[]
  triggers: Trigger[]
}

/** Polls one real issue and maps every event to a Trigger, in create-time order. */
export class GithubIssueSource {
  constructor(
    private readonly api: GithubApi,
    private readonly repo: GithubRepoRef,
    private readonly issueNumber: number,
  ) {}

  async pull(): Promise<GithubPull> {
    const [issue, comments] = await Promise.all([
      this.api.getIssue(this.issueNumber),
      this.api.listIssueComments(this.issueNumber),
    ])
    const ordered = [...comments].sort((left, right) => left.created_at.localeCompare(right.created_at))
    return {
      issue,
      comments: ordered,
      triggers: [
        githubIssueTrigger(this.repo, issue),
        ...ordered.map(comment => githubCommentTrigger(this.repo, issue, comment)),
      ],
    }
  }
}

/** Posts a Router outbox row as a real issue comment. */
export class GithubOutboxAdapter implements OutboundAdapter {
  readonly channel = 'github'

  constructor(
    private readonly api: GithubApi,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  async send(row: OutboxRow): Promise<{ externalId: string }> {
    const issue = Number(row.target.issue)
    if (!Number.isFinite(issue) || issue <= 0) {
      throw new Error(`github outbox row ${row.id} has no target.issue`)
    }
    const comment = await this.api.createIssueComment(issue, row.text)
    if (comment.id == null) throw new Error(`github comment API returned no id for issue #${issue}`)
    this.log(`[github] outbound comment issue=#${issue} commentId=${comment.id} ${comment.html_url ?? ''}`.trim())
    return { externalId: String(comment.id) }
  }
}

/**
 * Verify a real outbound comment by re-reading it from the API.
 * Returns the provider body so the demo can compare it with the outbox text.
 */
export async function readGithubComment(api: GithubApi, externalId: string): Promise<GithubComment> {
  const id = Number(externalId)
  if (!Number.isFinite(id) || id <= 0) throw new Error(`invalid GitHub comment id ${externalId}`)
  return api.getIssueComment(id)
}

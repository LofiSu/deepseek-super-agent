import {
  GhCliApi,
  parseRepo,
  runGh,
  type GhRun,
  type GithubApi,
  type GithubComment,
  type GithubIssue,
} from '../channels/github-source.ts'
import type { Store } from '../store/sqlite.ts'
import type { DispatchOwnerConfig } from './config.ts'
import { admitDispatchComment, admitDispatchIssueBody } from './admission.ts'
import {
  DISPATCH_CURSOR_KIND,
  DISPATCH_CURSOR_ID,
  DISPATCH_JOB_KIND,
  getDispatchCursor,
  markCommentHandled,
  putDispatchJob,
  seedDispatchCursorNow,
  wasCommentHandled,
  type DispatchJobDoc,
} from './store.ts'

export interface PollIssueComment {
  repoFull: string
  issue: GithubIssue & { pull_request?: unknown }
  comment: GithubComment
}

export interface GithubPollAdapter {
  listIssuesUpdatedSince(iso: string): Promise<(GithubIssue & { pull_request?: unknown })[]>
  getIssue(number: number): Promise<GithubIssue & { pull_request?: unknown }>
  listIssueComments(number: number): Promise<GithubComment[]>
}

export function apiPollAdapter(api: GithubApi, repoFull: string): GithubPollAdapter {
  const repo = parseRepo(repoFull)
  return {
    async listIssuesUpdatedSince(iso: string) {
      const q = encodeURIComponent(`repo:${repo.full} is:issue updated:>=${iso.slice(0, 10)}`)
      const page = await api.request<{
        items?: Array<GithubIssue & { pull_request?: unknown }>
        total_count?: number
      }>(`search/issues?q=${q}&per_page=30&sort=updated`)
      return page.items ?? []
    },
    getIssue: number => api.getIssue(number) as Promise<GithubIssue & { pull_request?: unknown }>,
    listIssueComments: number => api.listIssueComments(number),
  }
}

export function createDefaultPollAdapter(repoFull: string, gh: GhRun = runGh): GithubPollAdapter {
  const repo = parseRepo(repoFull)
  const api = new GhCliApi(repo, gh)
  return apiPollAdapter(api, repoFull)
}

export interface GithubPollEnqueueResult {
  admitted: PollIssueComment[]
  jobs: DispatchJobDoc[]
}

function commentCreatedAfter(comment: GithubComment, seededAt: string): boolean {
  return comment.created_at >= seededAt
}

export function issueBodyDedupeId(issue: GithubIssue): string {
  return `issue-body:${issue.id}`
}

function enqueueFixJob(
  store: Store,
  nextId: (prefix: string) => string,
  ev: {
    issue: GithubIssue
    dedupeId: string
    actorLogin: string
    command: string
  },
  jobs: DispatchJobDoc[],
): void {
  markCommentHandled(store, ev.dedupeId)
  const job: DispatchJobDoc = {
    id: nextId('dispatch'),
    type: 'github_fix',
    status: 'queued',
    createdAt: new Date().toISOString(),
    issueNumber: ev.issue.number,
    issueUrl: ev.issue.html_url,
    issueTitle: ev.issue.title ?? '',
    issueBody: ev.issue.body ?? '',
    commentId: ev.dedupeId,
    actorLogin: ev.actorLogin,
    command: ev.command,
  }
  putDispatchJob(store, job)
  jobs.push(job)
}

export function processGithubPoll(
  store: Store,
  config: DispatchOwnerConfig,
  events: PollIssueComment[],
  nextId: (prefix: string) => string,
  issueOnlyEvents: Array<{ repoFull: string; issue: GithubIssue & { pull_request?: unknown } }> = [],
): GithubPollEnqueueResult {
  const cursor = seedDispatchCursorNow(store)
  const admitted: PollIssueComment[] = []
  const jobs: DispatchJobDoc[] = []
  const mentionHandles = config.github.mentionHandles

  for (const ev of issueOnlyEvents) {
    const dedupeId = issueBodyDedupeId(ev.issue)
    if (wasCommentHandled(store, dedupeId)) continue

    const admission = admitDispatchIssueBody({
      configuredRepo: config.github.repo,
      authorizedActors: config.github.authorizedActors,
      mentionHandles,
      repoFullFromPayload: ev.repoFull,
      issue: ev.issue,
      seededAt: cursor.seededAt,
    })
    if (!admission.ok) continue

    if (admission.command === 'status' || admission.command === 'cancel') {
      markCommentHandled(store, dedupeId)
      if (admission.command === 'cancel') {
        const queued = store.listDocs<DispatchJobDoc>(DISPATCH_JOB_KIND)
          .filter(j => j.issueNumber === ev.issue.number && j.status === 'queued')
        for (const j of queued) {
          putDispatchJob(store, { ...j, status: 'cancelled', finishedAt: new Date().toISOString() })
        }
      }
      continue
    }

    enqueueFixJob(store, nextId, {
      issue: ev.issue,
      dedupeId,
      actorLogin: admission.actorLogin,
      command: admission.command,
    }, jobs)
  }

  for (const ev of events) {
    const commentKey = String(ev.comment.id)
    if (wasCommentHandled(store, commentKey)) continue
    if (!commentCreatedAfter(ev.comment, cursor.seededAt)) continue

    const admission = admitDispatchComment({
      configuredRepo: config.github.repo,
      authorizedActors: config.github.authorizedActors,
      mentionHandles,
      repoFullFromPayload: ev.repoFull,
      issue: ev.issue,
      comment: ev.comment,
    })
    if (!admission.ok) continue

    markCommentHandled(store, commentKey)

    if (admission.command === 'status' || admission.command === 'cancel') {
      if (admission.command === 'cancel') {
        const queued = store.listDocs<DispatchJobDoc>(DISPATCH_JOB_KIND)
          .filter(j => j.issueNumber === ev.issue.number && j.status === 'queued')
        for (const j of queued) {
          putDispatchJob(store, { ...j, status: 'cancelled', finishedAt: new Date().toISOString() })
        }
      }
      continue
    }

    const job: DispatchJobDoc = {
      id: nextId('dispatch'),
      type: 'github_fix',
      status: 'queued',
      createdAt: new Date().toISOString(),
      issueNumber: ev.issue.number,
      issueUrl: ev.issue.html_url,
      issueTitle: ev.issue.title ?? '',
      issueBody: ev.issue.body ?? '',
      commentId: commentKey,
      actorLogin: admission.actorLogin,
      command: admission.command,
    }
    putDispatchJob(store, job)
    jobs.push(job)
    admitted.push(ev)
  }

  const cur = getDispatchCursor(store) ?? cursor
  store.putDoc(DISPATCH_CURSOR_KIND, DISPATCH_CURSOR_ID, {
    ...cur,
    lastPolledAt: new Date().toISOString(),
  })

  return { admitted, jobs }
}

export async function fetchPollEvents(
  adapter: GithubPollAdapter,
  config: DispatchOwnerConfig,
  seededAt: string,
): Promise<{ comments: PollIssueComment[]; issueBodies: Array<{ repoFull: string; issue: GithubIssue & { pull_request?: unknown } }> }> {
  const repoFull = config.github.repo
  const issues = await adapter.listIssuesUpdatedSince(seededAt)
  const comments: PollIssueComment[] = []
  const issueBodies: Array<{ repoFull: string; issue: GithubIssue & { pull_request?: unknown } }> = []
  for (const issue of issues) {
    if (issue.pull_request != null) continue
    const full = await adapter.getIssue(issue.number)
    if (full.pull_request != null) continue
    if (full.created_at >= seededAt) {
      issueBodies.push({ repoFull, issue: full })
    }
    const commentList = await adapter.listIssueComments(issue.number)
    for (const comment of commentList) {
      comments.push({ repoFull, issue: full, comment })
    }
  }
  return { comments, issueBodies }
}

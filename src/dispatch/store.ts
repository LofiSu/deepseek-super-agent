import type { Store } from '../store/sqlite.ts'

export const DISPATCH_CURSOR_KIND = 'github_dispatch_cursor'
export const DISPATCH_CURSOR_ID = 'cursor'
export const DISPATCH_JOB_KIND = 'dispatch_job'
export const DISPATCH_HANDLED_KIND = 'dispatch_handled_comment'
export const DISPATCH_GAP_KIND = 'dispatch_gap'
export const DISPATCH_QUEUE_KIND = 'dispatch_queue'

export type DispatchJobType = 'github_fix' | 'rsi_implement' | 'rsi_proposal'

export type DispatchJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface GithubDispatchCursorDoc {
  /** ISO time — first start seeds to now; no historical replay. */
  seededAt: string
  lastPolledAt?: string
}

export interface DispatchJobDoc {
  id: string
  type: DispatchJobType
  status: DispatchJobStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  issueNumber?: number
  issueUrl?: string
  issueTitle?: string
  issueBody?: string
  commentId: string
  actorLogin?: string
  command?: string
  prUrl?: string
  prNumber?: number
  error?: string
  gapId?: string
  /** At most one automatic requeue after interrupted. */
  requeueCount?: number
}

export interface DispatchQueueDoc {
  /** Job id currently running, if any. */
  runningJobId?: string
  lastRsiTickAt?: string
}

export type GapRisk = 'low' | 'high'

export interface DispatchGapDoc {
  id: string
  title: string
  description: string
  acceptance: string
  risk: GapRisk
  priority: number
  sourceUrl: string
  fetchedAt: string
  manusCue: 'unknown'
  status: 'open' | 'proposal' | 'implemented' | 'dismissed'
  dedupeKey: string
}

export function getDispatchCursor(store: Store): GithubDispatchCursorDoc | undefined {
  return store.getDoc<GithubDispatchCursorDoc>(DISPATCH_CURSOR_KIND, DISPATCH_CURSOR_ID)
}

export function seedDispatchCursorNow(store: Store): GithubDispatchCursorDoc {
  const existing = getDispatchCursor(store)
  if (existing) return existing
  const doc: GithubDispatchCursorDoc = { seededAt: new Date().toISOString() }
  store.putDoc(DISPATCH_CURSOR_KIND, DISPATCH_CURSOR_ID, doc)
  return doc
}

export function markCommentHandled(store: Store, commentId: string): void {
  store.putDoc(DISPATCH_HANDLED_KIND, String(commentId), { commentId, at: new Date().toISOString() })
}

export function wasCommentHandled(store: Store, commentId: string): boolean {
  return store.getDoc(DISPATCH_HANDLED_KIND, String(commentId)) !== undefined
}

export function putDispatchJob(store: Store, job: DispatchJobDoc): void {
  store.putDoc(DISPATCH_JOB_KIND, job.id, job)
}

export function getDispatchJob(store: Store, id: string): DispatchJobDoc | undefined {
  return store.getDoc<DispatchJobDoc>(DISPATCH_JOB_KIND, id)
}

export function listDispatchJobs(store: Store): DispatchJobDoc[] {
  return store.listDocs<DispatchJobDoc>(DISPATCH_JOB_KIND)
}

export function getQueueState(store: Store): DispatchQueueDoc {
  return store.getDoc<DispatchQueueDoc>(DISPATCH_QUEUE_KIND, 'main') ?? {}
}

export function putQueueState(store: Store, state: DispatchQueueDoc): void {
  store.putDoc(DISPATCH_QUEUE_KIND, 'main', state)
}

export function recoverInterruptedJobs(store: Store): void {
  const queue = getQueueState(store)
  const jobs = listDispatchJobs(store)
  for (const job of jobs) {
    if (job.status !== 'running') continue
    const count = job.requeueCount ?? 0
    if (count < 1) {
      putDispatchJob(store, {
        ...job,
        status: 'queued',
        startedAt: undefined,
        requeueCount: count + 1,
        error: 'requeued after interrupted run',
      })
    } else {
      putDispatchJob(store, {
        ...job,
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: job.error ?? 'interrupted; requeue limit exceeded',
      })
    }
  }
  if (queue.runningJobId) {
    putQueueState(store, { ...queue, runningJobId: undefined })
  }
}

export function putGap(store: Store, gap: DispatchGapDoc): void {
  store.putDoc(DISPATCH_GAP_KIND, gap.id, gap)
}

export function listGaps(store: Store): DispatchGapDoc[] {
  return store.listDocs<DispatchGapDoc>(DISPATCH_GAP_KIND)
}

export function findGapByDedupe(store: Store, dedupeKey: string): DispatchGapDoc | undefined {
  return listGaps(store).find(g => g.dedupeKey === dedupeKey)
}

import type { Store } from '../store/sqlite.ts'
import type { JobRunner } from './job-runner.ts'
import {
  DISPATCH_GAP_KIND,
  getDispatchJob,
  getQueueState,
  listDispatchJobs,
  putDispatchJob,
  putQueueState,
  type DispatchGapDoc,
  type DispatchJobDoc,
} from './store.ts'

export interface RunDispatchJobContext {
  issueTitle?: string
  issueBody?: string
}

export interface DispatchQueueOptions {
  store: Store
  runner: JobRunner
  log?: (line: string) => void
  hasOpenPeanutPr?: (branchPrefix: string) => Promise<boolean>
}

function sortQueued(jobs: DispatchJobDoc[]): DispatchJobDoc[] {
  return jobs
    .filter(j => j.status === 'queued')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function drainDispatchQueue(
  options: DispatchQueueOptions,
  ctxByJobId: ReadonlyMap<string, RunDispatchJobContext> = new Map(),
): Promise<void> {
  const log = options.log ?? (() => undefined)
  const queue = getQueueState(options.store)
  if (queue.runningJobId) {
    const running = getDispatchJob(options.store, queue.runningJobId)
    if (running?.status === 'running') return
    putQueueState(options.store, { ...queue, runningJobId: undefined })
  }

  const next = sortQueued(listDispatchJobs(options.store))[0]
  if (!next) return

  putQueueState(options.store, { ...getQueueState(options.store), runningJobId: next.id })
  putDispatchJob(options.store, { ...next, status: 'running', startedAt: new Date().toISOString() })

  try {
    if (next.type === 'github_fix') {
      const ctx = ctxByJobId.get(next.id)
      const out = await options.runner.runGithubFix({
        job: next,
        issueTitle: ctx?.issueTitle ?? next.issueTitle ?? `Issue #${next.issueNumber ?? ''}`,
        issueBody: ctx?.issueBody ?? next.issueBody ?? '',
      })
      putDispatchJob(options.store, {
        ...getDispatchJob(options.store, next.id)!,
        status: 'completed',
        finishedAt: new Date().toISOString(),
        prUrl: out.prUrl,
        prNumber: out.prNumber,
      })
      log(`[dispatch] github_fix ${next.id} completed pr=${out.prUrl ?? 'n/a'}`)
    } else if (next.type === 'rsi_implement') {
      const gap = options.store.getDoc<DispatchGapDoc>(DISPATCH_GAP_KIND, next.gapId ?? '')
      if (!gap) throw new Error(`missing gap for job ${next.id}`)
      if (options.hasOpenPeanutPr) {
        const open = await options.hasOpenPeanutPr(`peanut/rsi-${gap.id}`)
        if (open) {
          putDispatchJob(options.store, {
            ...getDispatchJob(options.store, next.id)!,
            status: 'failed',
            finishedAt: new Date().toISOString(),
            error: 'idle: equivalent open peanut/* PR exists',
          })
          log(`[dispatch] rsi_implement ${next.id} idle duplicate PR`)
          return
        }
      }
      const out = await options.runner.runRsiImplement({ job: next, gap })
      putDispatchJob(options.store, {
        ...getDispatchJob(options.store, next.id)!,
        status: 'completed',
        finishedAt: new Date().toISOString(),
        prUrl: out.prUrl,
        prNumber: out.prNumber,
      })
      log(`[dispatch] rsi_implement ${next.id} completed`)
    } else if (next.type === 'rsi_proposal') {
      putDispatchJob(options.store, {
        ...getDispatchJob(options.store, next.id)!,
        status: 'completed',
        finishedAt: new Date().toISOString(),
      })
      log(`[dispatch] rsi_proposal ${next.id} recorded`)
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    putDispatchJob(options.store, {
      ...getDispatchJob(options.store, next.id)!,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: msg,
    })
    log(`[dispatch] job ${next.id} failed: ${msg}`)
  } finally {
    putQueueState(options.store, { ...getQueueState(options.store), runningJobId: undefined })
  }

  await drainDispatchQueue(options, ctxByJobId)
}

export function cancelDispatchJob(store: Store, jobId: string): boolean {
  const job = getDispatchJob(store, jobId)
  if (!job) return false
  if (job.status !== 'queued' && job.status !== 'running') return false
  putDispatchJob(store, {
    ...job,
    status: 'cancelled',
    finishedAt: new Date().toISOString(),
  })
  const queue = getQueueState(store)
  if (queue.runningJobId === jobId) {
    putQueueState(store, { ...queue, runningJobId: undefined })
  }
  return true
}

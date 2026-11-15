import type { Store } from '../store/sqlite.ts'
import { cancelDispatchJob } from './queue.ts'
import { listDispatchJobs } from './store.ts'

export function formatDispatchStatus(store: Store): string {
  const jobs = listDispatchJobs(store)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 32)
  if (jobs.length === 0) return 'dispatch: no jobs'
  const lines = ['dispatch jobs (local only; no GitHub comments):']
  for (const j of jobs) {
    const pr = j.prUrl ? ` pr=${j.prUrl}` : ''
    lines.push(
      `  ${j.id}\t${j.type}\t${j.status}\tissue=${j.issueNumber ?? '-'}${pr}`,
    )
  }
  return lines.join('\n')
}

export function runDispatchCancel(store: Store, jobId: string): string {
  const ok = cancelDispatchJob(store, jobId)
  return ok ? `dispatch: cancelled ${jobId}` : `dispatch: cannot cancel ${jobId} (missing or not queued/running)`
}

import { parseRepo, runGh } from '../channels/github-source.ts'
import type { Store } from '../store/sqlite.ts'
import type { DispatchOwnerConfig } from './config.ts'
import { createJobRunner } from './job-runner.ts'
import { fetchPollEvents, issueBodyDedupeId, processGithubPoll, type GithubPollAdapter } from './github-poll.ts'
import { DISPATCH_CURSOR_ID, DISPATCH_CURSOR_KIND, recoverInterruptedJobs } from './store.ts'
import { drainDispatchQueue } from './queue.ts'
import { runRsiSchedulerTick } from './rsi.ts'

export interface DispatchServeOptions {
  home: string
  store: Store
  config: DispatchOwnerConfig
  log: (line: string) => void
  pollAdapter?: GithubPollAdapter
  gh?: typeof runGh
  signal?: AbortSignal
  jobRunner?: ReturnType<typeof createJobRunner>
  hasOpenPeanutPr?: (branch: string) => Promise<boolean>
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}

export async function runDispatchServeLoop(options: DispatchServeOptions): Promise<void> {
  const { store, config, log } = options
  recoverInterruptedJobs(store)

  parseRepo(config.github.repo)
  const runner = options.jobRunner ?? createJobRunner()

  const poll = options.pollAdapter
  let failures = 0

  const ctxByJob = new Map<string, { issueTitle: string; issueBody: string }>()

  while (!options.signal?.aborted) {
    try {
      if (config.github.enabled && poll) {
        const cursor = store.getDoc<{ seededAt: string }>(DISPATCH_CURSOR_KIND, DISPATCH_CURSOR_ID)
        const seededAt = cursor?.seededAt ?? new Date().toISOString()
        const { comments, issueBodies } = await fetchPollEvents(poll, config, seededAt)
        const { jobs } = processGithubPoll(store, config, comments, p => store.nextId(p), issueBodies)
        for (const job of jobs) {
          let title = job.issueTitle
          let body = job.issueBody
          const ev = comments.find(e => String(e.comment.id) === job.commentId)
          if (ev) {
            title = ev.issue.title ?? title
            body = ev.issue.body ?? body
          } else if (job.commentId.startsWith('issue-body:')) {
            const iss = issueBodies.find(e => issueBodyDedupeId(e.issue) === job.commentId)
            if (iss) {
              title = iss.issue.title ?? title
              body = iss.issue.body ?? body
            }
          }
          if (title !== undefined || body !== undefined) {
            ctxByJob.set(job.id, {
              issueTitle: title ?? '',
              issueBody: body ?? '',
            })
          }
        }
      }

      if (config.rsi.enabled) {
        await runRsiSchedulerTick(store, config, p => store.nextId(p), {
          hasOpenPeanutPr: options.hasOpenPeanutPr,
          log,
        })
      }

      await drainDispatchQueue(
        { store, runner, log, hasOpenPeanutPr: options.hasOpenPeanutPr },
        ctxByJob,
      )
      failures = 0
    } catch (error) {
      failures += 1
      log(`[dispatch] loop error: ${error instanceof Error ? error.message : String(error)}`)
    }

    const delay = Math.min(
      config.github.pollIntervalMs * 2 ** Math.min(failures, 6),
      120_000,
    )
    await sleep(config.github.enabled ? config.github.pollIntervalMs : config.rsi.intervalMs, options.signal)
    if (failures > 0) await sleep(delay, options.signal)
  }
}

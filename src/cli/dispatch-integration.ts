import fs from 'node:fs'
import path from 'node:path'
import type { Runtime } from '../runtime.ts'
import { loadDispatchOwnerConfig } from '../dispatch/config.ts'
import { ghRunForDispatchHost } from '../dispatch/github-app-auth.ts'
import { createDefaultPollAdapter } from '../dispatch/github-poll.ts'
import { hasOpenPeanutPrForRepo } from '../dispatch/github-peanut.ts'
import { createClaudeDispatchJobRunner } from '../dispatch/implementer.ts'
import { createJobRunner } from '../dispatch/job-runner.ts'
import { runDispatchServeLoop } from '../dispatch/serve-loop.ts'

export interface StartedDispatchLoop {
  abort(): void
  wait(): Promise<void>
}

/**
 * Start the shared GitHub dispatch + RSI queue loop when owner config enables it.
 * No HTTP listener; polling only. Config lives in DS_AGENT_HOME, outside workspaces.
 */
export async function startDispatchLoopIfConfigured(
  home: string,
  runtime: Runtime,
  opts: {
    verifyGh?: boolean
    force?: boolean
    /** When serve already loaded + bootstrapped config, pass it to avoid duplicate verify. */
    config?: Awaited<ReturnType<typeof loadDispatchOwnerConfig>>
  } = {},
): Promise<StartedDispatchLoop | undefined> {
  if (!opts.force && !dispatchLoadRequested()) return undefined
  const config = opts.config ?? await loadDispatchOwnerConfig(home, {
    verifyMentions: opts.verifyGh !== false,
  })
  if (!config) return undefined

  const gh = await ghRunForDispatchHost(
    config.githubAuthHost ?? { auth: config.github.auth ?? { mode: 'owner-gh' } },
  )
  const app = config.githubAuthHost?.app
  const appGit = app ? app.createAuthenticatedGitRun() : undefined

  const abort = new AbortController()
  const poll = config.github.enabled
    ? createDefaultPollAdapter(config.github.repo, gh)
    : undefined

  const repoFull = config.github.repo
  const hasOpenPeanutPr = async (headBranch: string): Promise<boolean> => {
    try {
      return await hasOpenPeanutPrForRepo(repoFull, headBranch, gh)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      runtime.log.info(`[dispatch] hasOpenPeanutPr check failed (${msg}); skipping enqueue this tick`)
      throw error
    }
  }

  const implementer = config.github.implementer
  const jobRunner = implementer === 'claude'
    ? createClaudeDispatchJobRunner({
        github: config.github,
        defaultSourceRepo: process.cwd(),
        gh,
        git: appGit,
      })
    : createJobRunner()

  const task = runDispatchServeLoop({
    home,
    store: runtime.store,
    config,
    log: line => runtime.log.info(line),
    pollAdapter: poll,
    signal: abort.signal,
    jobRunner,
    hasOpenPeanutPr,
  })

  return {
    abort: () => abort.abort(),
    wait: () => task.then(() => undefined).catch(() => undefined),
  }
}

/**
 * Dispatch runs when owner config enables GitHub and/or RSI. The flag/env only
 * gates whether serve attempts to load that config (offline home file).
 */
export function dispatchLoadRequested(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (argv.includes('--github-dispatch')) return true
  const v = env.DS_AGENT_GITHUB_DISPATCH?.trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'yes') return true
  // Auto-start when the owner config file exists and enables a subsystem.
  return fs.existsSync(path.join(
    env.DS_AGENT_HOME ?? path.join(process.cwd(), '.ds-agent'),
    'github-dispatch.json',
  ))
}

import type { FeaturePrPublisher } from '../env/git-publish.ts'
import type { LocalEnv } from '../env/local-env.ts'
import type { DispatchGapDoc, DispatchJobDoc } from './store.ts'

export const IMPLEMENTER_NOT_CONFIGURED =
  'implementer not configured; refusing empty publish'

export interface GithubFixJobContext {
  job: DispatchJobDoc
  issueTitle: string
  issueBody: string
}

export interface RsiImplementContext {
  job: DispatchJobDoc
  gap: DispatchGapDoc
}

export interface JobRunner {
  runGithubFix(ctx: GithubFixJobContext): Promise<{ prUrl?: string; prNumber?: number }>
  runRsiImplement(ctx: RsiImplementContext): Promise<{ prUrl?: string; prNumber?: number }>
}

export interface JobRunnerDeps {
  publisher?: FeaturePrPublisher
  env?: LocalEnv
  /** Fixture or production implementation hook. Required for publish in production. */
  githubFix?: (ctx: GithubFixJobContext) => Promise<{ prUrl?: string; prNumber?: number }>
  rsiImplement?: (ctx: RsiImplementContext) => Promise<{ prUrl?: string; prNumber?: number }>
}

/**
 * Injected runner for tests. Production must supply githubFix / rsiImplement;
 * publisher+env alone does not commit docs dumps or publish.
 */
export function createJobRunner(deps: JobRunnerDeps = {}): JobRunner {
  return {
    async runGithubFix(ctx) {
      if (deps.githubFix) return deps.githubFix(ctx)
      throw new Error(IMPLEMENTER_NOT_CONFIGURED)
    },
    async runRsiImplement(ctx) {
      if (deps.rsiImplement) return deps.rsiImplement(ctx)
      throw new Error(IMPLEMENTER_NOT_CONFIGURED)
    },
  }
}

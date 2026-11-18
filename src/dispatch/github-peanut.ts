import { parseRepo, runGh, type GhRun, type GithubRepoRef } from '../channels/github-source.ts'

/**
 * True only when an open PR with exact head branch exists. On gh failure, throws
 * so schedulers fail-safe (skip enqueue) instead of assuming no duplicate PR.
 */
export async function hasOpenPeanutPrForRepo(
  repoFull: string,
  headBranch: string,
  gh: GhRun = runGh,
): Promise<boolean> {
  const repo: GithubRepoRef = parseRepo(repoFull)
  const out = await gh([
    'pr', 'list',
    '--repo', repo.full,
    '--head', headBranch,
    '--base', 'main',
    '--state', 'open',
    '--json', 'number',
    '--limit', '1',
  ])
  const items = out.trim() ? (JSON.parse(out) as { number: number }[]) : []
  return items.length > 0
}

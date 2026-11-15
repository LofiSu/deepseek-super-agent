import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { GhCliApi, type GithubComment, type GithubIssue } from '../src/channels/github-source.ts'
import {
  admitDispatchComment,
  admitDispatchIssueBody,
  parseDispatchCommand,
  stripNonCommandRegions,
} from '../src/dispatch/admission.ts'
import {
  loadDispatchOwnerConfigSync,
  MIN_POLL_INTERVAL_MS,
  UNOWNED_PUBLIC_HANDLE,
} from '../src/dispatch/config.ts'
import { apiPollAdapter, createDefaultPollAdapter, processGithubPoll } from '../src/dispatch/github-poll.ts'
import { hasOpenPeanutPrForRepo } from '../src/dispatch/github-peanut.ts'
import { createClaudeDispatchJobRunner } from '../src/dispatch/implementer.ts'
import { createJobRunner, IMPLEMENTER_NOT_CONFIGURED } from '../src/dispatch/job-runner.ts'
import { drainDispatchQueue } from '../src/dispatch/queue.ts'
import {
  acceptanceFromInstinctEvidenceColumn,
  classifyGapRisk,
  ingestCompetitiveGapFromFile,
  ingestGap,
  isImplementableLowRiskGap,
  runRsiSchedulerTick,
  RSI_RESEARCH_CACHE_KIND,
} from '../src/dispatch/rsi.ts'
import {
  recoverInterruptedJobs,
  seedDispatchCursorNow,
  wasCommentHandled,
  type DispatchGapDoc,
  type DispatchJobDoc,
} from '../src/dispatch/store.ts'
import { trustedFetch } from '../src/dispatch/trusted-fetch.ts'
import { formatDispatchStatus, runDispatchCancel } from '../src/dispatch/cli.ts'
import { verifyGithubWebhookSignature256 } from '../src/dispatch/webhook-verify.ts'
import { FeaturePrPublisher } from '../src/env/git-publish.ts'
import { parseRepo } from '../src/channels/github-source.ts'
import { Store } from '../src/store/sqlite.ts'
import { tempHome } from './fixtures.ts'

const REPO = 'LofiSu/deepseek-super-agent'

function issue(n: number, extra: Partial<GithubIssue> = {}): GithubIssue & { pull_request?: unknown } {
  return {
    id: 9000 + n,
    number: n,
    title: 'bug',
    body: 'details',
    created_at: '2026-11-20T12:00:00Z',
    html_url: `https://github.com/${REPO}/issues/${n}`,
    user: { login: 'LofiSu', type: 'User' },
    ...extra,
  }
}

function comment(
  id: number,
  body: string,
  login = 'LofiSu',
  created = '2026-11-20T12:01:00Z',
): GithubComment {
  return {
    id,
    body,
    created_at: created,
    user: { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' },
  }
}

function dispatchConfig(home: string, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(home, 'github-dispatch.json'), JSON.stringify({
    github: { enabled: true, repo: REPO, authorizedActors: ['LofiSu'] },
    rsi: { enabled: true, intervalMs: 0 },
    ...extra,
  }))
}

describe('dispatch admission', () => {
  it('accepts /ds-agent fix from LofiSu on a normal issue', () => {
    const r = admitDispatchComment({
      configuredRepo: REPO,
      authorizedActors: ['LofiSu'],
      repoFullFromPayload: REPO,
      issue: issue(1),
      comment: comment(101, '/ds-agent fix'),
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.command).toBe('fix')
  })

  it('accepts @LofiSu fix when mentionHandles configured', () => {
    const r = admitDispatchComment({
      configuredRepo: REPO,
      authorizedActors: ['LofiSu'],
      mentionHandles: ['LofiSu'],
      repoFullFromPayload: REPO,
      issue: issue(1),
      comment: comment(102, '@LofiSu fix'),
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.command).toBe('fix')
    expect(parseDispatchCommand('@LofiSu /ds-agent status', ['LofiSu'])).toBe('status')
    expect(parseDispatchCommand('@ds-agent fix', ['LofiSu'])).toBeUndefined()
    expect(parseDispatchCommand('@ds-agent fix')).toBeUndefined()
  })

  it('admits fix command in new issue body after cursor seed', () => {
    const store = new Store(tempHome())
    const cursor = seedDispatchCursorNow(store)
    const iss = issue(88, {
      body: '/ds-agent fix\nmore context',
      created_at: new Date().toISOString(),
    })
    const r = admitDispatchIssueBody({
      configuredRepo: REPO,
      authorizedActors: ['LofiSu'],
      repoFullFromPayload: REPO,
      issue: iss,
      seededAt: cursor.seededAt,
    })
    expect(r.ok).toBe(true)
    store.close()
  })

  it('rejects outsider, wrong repo, PR, fence, bot, historical replay fields', () => {
    const base = {
      configuredRepo: REPO,
      authorizedActors: ['LofiSu'],
      repoFullFromPayload: REPO,
      issue: issue(2),
    }
    expect(admitDispatchComment({ ...base, comment: comment(1, '/ds-agent fix', 'evil') }).ok).toBe(false)
    expect(admitDispatchComment({
      ...base,
      repoFullFromPayload: 'other/repo',
      comment: comment(2, '/ds-agent fix'),
    }).ok).toBe(false)
    expect(admitDispatchComment({
      ...base,
      issue: { ...issue(3), pull_request: {} },
      comment: comment(3, '/ds-agent fix'),
    }).ok).toBe(false)
    expect(admitDispatchComment({
      ...base,
      comment: comment(4, '```\n/ds-agent fix\n```'),
    }).ok).toBe(false)
    expect(admitDispatchComment({
      ...base,
      comment: comment(5, '> /ds-agent fix'),
    }).ok).toBe(false)
    expect(admitDispatchComment({
      ...base,
      comment: comment(6, '/ds-agent fix', 'dependabot[bot]'),
    }).ok).toBe(false)
    expect(parseDispatchCommand('` /ds-agent fix`')).toBeUndefined()
    expect(parseDispatchCommand(stripNonCommandRegions('```\n/ds-agent fix\n```'))).toBeUndefined()
  })
})

describe('dispatch config', () => {
  it('refuses unverifiable ds-agent mention handle', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, 'github-dispatch.json'), JSON.stringify({
      github: { enabled: true, mentionHandles: [UNOWNED_PUBLIC_HANDLE] },
    }))
    expect(() => loadDispatchOwnerConfigSync(home)).toThrow(/unverifiable|unrelated/i)
  })

  it('enforces minimum pollIntervalMs', () => {
    const home = tempHome()
    fs.writeFileSync(path.join(home, 'github-dispatch.json'), JSON.stringify({
      github: { enabled: true, pollIntervalMs: 1000 },
    }))
    const cfg = loadDispatchOwnerConfigSync(home)!
    expect(cfg.github.pollIntervalMs).toBe(MIN_POLL_INTERVAL_MS)
  })
})

describe('dispatch job runner', () => {
  it('default runner refuses publish without implementer', async () => {
    const runner = createJobRunner()
    const pub = { publish: vi.fn() }
    await expect(runner.runGithubFix({
      job: { id: '1', type: 'github_fix', status: 'queued', createdAt: '', commentId: 'c' },
      issueTitle: 't',
      issueBody: 'b',
    })).rejects.toThrow(IMPLEMENTER_NOT_CONFIGURED)
    await expect(runner.runRsiImplement({
      job: { id: '2', type: 'rsi_implement', status: 'queued', createdAt: '', commentId: 'c' },
      gap: {
        id: 'g',
        title: 'x',
        description: 'd',
        acceptance: 'a',
        risk: 'low',
        priority: 1,
        sourceUrl: 'u',
        fetchedAt: 't',
        manusCue: 'unknown',
        status: 'open',
        dedupeKey: 'k',
      },
    })).rejects.toThrow(IMPLEMENTER_NOT_CONFIGURED)
    expect(pub.publish).not.toHaveBeenCalled()
  })
})

describe('createDefaultPollAdapter', () => {
  it('defaults to runGh and uses injected gh for API calls', async () => {
    const calls: string[][] = []
    const gh = async (args: string[]) => {
      calls.push(args)
      return '[]'
    }
    const adapter = createDefaultPollAdapter(REPO, gh)
    expect(adapter).toBeTruthy()
    await adapter.listIssueComments(1)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0]!.join(' ')).toMatch(/issues\/1\/comments/)
  })

  it('constructs GhCliApi-backed adapter without passing gh explicitly', () => {
    const gh = vi.fn(async () => '[]')
    const api = new GhCliApi(parseRepo(REPO), gh)
    const poll = apiPollAdapter(api, REPO)
    expect(poll).toBeTruthy()
  })
})

describe('dispatch poll cursor and dedup', () => {
  it('seeds cursor to now and does not enqueue pre-cursor comments; replays dedupe', () => {
    const home = tempHome()
    const store = new Store(home)
    dispatchConfig(home)
    const cfg = loadDispatchOwnerConfigSync(home)!
    seedDispatchCursorNow(store)
    const cursor = store.getDoc<{ seededAt: string }>('github_dispatch_cursor', 'cursor')!

    const old = comment(200, '/ds-agent fix', 'LofiSu', '2020-01-01T00:00:00Z')
    const evOld = { repoFull: REPO, issue: issue(10), comment: old }
    const { jobs: j0 } = processGithubPoll(store, cfg, [evOld], p => store.nextId(p))
    expect(j0).toHaveLength(0)

    const fresh = comment(201, '/ds-agent fix', 'LofiSu', new Date().toISOString())
    const { jobs: j1 } = processGithubPoll(store, cfg, [
      { repoFull: REPO, issue: issue(11), comment: fresh },
    ], p => store.nextId(p))
    expect(j1).toHaveLength(1)
    expect(j1[0]!.issueTitle).toBe('bug')
    expect(j1[0]!.issueBody).toBeTruthy()

    const { jobs: j2 } = processGithubPoll(store, cfg, [
      { repoFull: REPO, issue: issue(11), comment: fresh },
    ], p => store.nextId(p))
    expect(j2).toHaveLength(0)
    expect(wasCommentHandled(store, '201')).toBe(true)
    expect(cursor.seededAt <= fresh.created_at || fresh.created_at >= cursor.seededAt).toBe(true)
    store.close()
  })

  it('enqueues github_fix from issue body dedupe issue-body:id', () => {
    const home = tempHome()
    const store = new Store(home)
    dispatchConfig(home)
    const cfg = loadDispatchOwnerConfigSync(home)!
    const cursor = seedDispatchCursorNow(store)
    const iss = issue(42, {
      id: 4242,
      body: '/ds-agent fix',
      created_at: new Date().toISOString(),
    })
    const { jobs } = processGithubPoll(
      store,
      cfg,
      [],
      p => store.nextId(p),
      [{ repoFull: REPO, issue: iss }],
    )
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.commentId).toBe('issue-body:4242')
    expect(jobs[0]!.issueTitle).toBe('bug')
    expect(jobs[0]!.issueBody).toBe('/ds-agent fix')
    expect(wasCommentHandled(store, 'issue-body:4242')).toBe(true)
    expect(cursor).toBeTruthy()
    store.close()
  })
})

describe('dispatch local status and cancel', () => {
  it('updates local job state only', () => {
    const home = tempHome()
    const store = new Store(home)
    const job: DispatchJobDoc = {
      id: 'dispatch_1',
      type: 'github_fix',
      status: 'queued',
      createdAt: new Date().toISOString(),
      commentId: '999',
      issueNumber: 5,
    }
    store.putDoc('dispatch_job' as const, job.id, job)
    expect(formatDispatchStatus(store)).toContain('dispatch_1')
    expect(runDispatchCancel(store, 'dispatch_1')).toContain('cancelled')
    expect(store.getDoc<DispatchJobDoc>('dispatch_job', 'dispatch_1')?.status).toBe('cancelled')
    store.close()
  })
})

describe('dispatch queue persisted issue context', () => {
  it('drains github_fix using stored issueTitle/issueBody when ctx map is empty', async () => {
    const home = tempHome()
    const store = new Store(home)
    let seenTitle = ''
    let seenBody = ''
    const runner = createJobRunner({
      githubFix: async ctx => {
        seenTitle = ctx.issueTitle
        seenBody = ctx.issueBody
        return {}
      },
    })
    const job: DispatchJobDoc = {
      id: 'persisted',
      type: 'github_fix',
      status: 'queued',
      createdAt: new Date().toISOString(),
      commentId: 'issue-body:1',
      issueNumber: 9,
      issueTitle: 'stored title',
      issueBody: 'stored body',
    }
    store.putDoc('dispatch_job', job.id, job)
    await drainDispatchQueue({ store, runner }, new Map())
    expect(seenTitle).toBe('stored title')
    expect(seenBody).toBe('stored body')
    store.close()
  })
})

describe('dispatch queue', () => {
  it('runs one job at a time and recovers interrupted without duplicating completed', async () => {
    const home = tempHome()
    const store = new Store(home)
    const calls: string[] = []
    const runner = createJobRunner({
      githubFix: async () => {
        calls.push('run')
        return { prUrl: 'https://example/pr/1', prNumber: 1 }
      },
    })
    store.putDoc('dispatch_job', 'a', {
      id: 'a',
      type: 'github_fix',
      status: 'queued',
      createdAt: '2026-11-01T00:00:00Z',
      commentId: '1',
    } satisfies DispatchJobDoc)
    store.putDoc('dispatch_job', 'b', {
      id: 'b',
      type: 'github_fix',
      status: 'queued',
      createdAt: '2026-11-01T00:00:01Z',
      commentId: '2',
    } satisfies DispatchJobDoc)
    await drainDispatchQueue({ store, runner })
    expect(calls).toEqual(['run', 'run'])
    expect(store.getDoc<DispatchJobDoc>('dispatch_job', 'a')?.status).toBe('completed')

    store.putDoc('dispatch_job', 'dead', {
      id: 'dead',
      type: 'github_fix',
      status: 'running',
      createdAt: '2026-11-01T00:00:02Z',
      commentId: '3',
    } satisfies DispatchJobDoc)
    store.putDoc('dispatch_queue', 'main', { runningJobId: 'dead' })
    recoverInterruptedJobs(store)
    expect(store.getDoc<DispatchJobDoc>('dispatch_job', 'dead')?.status).toBe('queued')
    store.close()
  })
})

describe('dispatch fix job with FeaturePrPublisher', () => {
  it('publishes peanut branch via fixture gh without merging main', async () => {
    const root = tempHome()
    const bare = path.join(root, 'remote.git')
    execSync(`git init --bare -b main ${JSON.stringify(bare)}`, { stdio: 'ignore' })
    const runner = createJobRunner({
      githubFix: async () => {
        const ws = path.join(root, 'ws')
        fs.mkdirSync(ws)
        execSync('git init -b main', { cwd: ws, env: { GIT_CONFIG_NOSYSTEM: '1' } })
        execSync('git config user.email t@t.com && git config user.name t', { cwd: ws })
        fs.writeFileSync(path.join(ws, 'f'), 'x\n')
        execSync('git add f && git commit -m seed', { cwd: ws })
        execSync(`git checkout -b peanut/dispatch-issue-7`, { cwd: ws })
        const gh = vi.fn(async (args: string[]) => {
          if (args[1] === 'list') return '[]'
          if (args[1] === 'create') return 'https://github.com/o/r/pull/7\n'
          if (args[1] === 'view') return JSON.stringify({ number: 7, url: 'https://github.com/o/r/pull/7' })
          return ''
        })
        const gitReal = await import('../src/env/git-publish.ts')
        const pub = new FeaturePrPublisher({
          repo: parseRepo(REPO),
          workspace: () => ws,
          pushRemote: bare,
          git: gitReal.runGit,
          gh,
        })
        const result = await pub.publish({
          workerId: 'w',
          title: 'fix: issue #7',
          body: `Issue: https://github.com/${REPO}/issues/7`,
          branch: 'peanut/dispatch-issue-7',
        })
        expect(result.branch).toMatch(/^peanut\//)
        expect(result.number).toBe(7)
        return { prUrl: result.url, prNumber: result.number }
      },
    })
    const home = tempHome()
    const store = new Store(home)
    const job: DispatchJobDoc = {
      id: 'dispatch_7',
      type: 'github_fix',
      status: 'queued',
      createdAt: new Date().toISOString(),
      commentId: '77',
      issueNumber: 7,
      issueUrl: `https://github.com/${REPO}/issues/7`,
    }
    store.putDoc('dispatch_job' as const, job.id, job)
    await drainDispatchQueue({ store, runner })
    const done = store.getDoc<DispatchJobDoc>('dispatch_job', job.id)
    expect(done?.status).toBe('completed')
    expect(done?.prNumber).toBe(7)
    expect(done?.prUrl).toContain('/pull/7')
    store.close()
  })
})

describe('hasOpenPeanutPrForRepo', () => {
  it('returns true when gh lists an open PR for head branch', async () => {
    const gh = vi.fn(async () => '[{"number":3}]')
    await expect(hasOpenPeanutPrForRepo(REPO, 'peanut/dispatch-issue-1', gh)).resolves.toBe(true)
    const firstCall = gh.mock.calls[0] as string[] | undefined
    expect(firstCall?.[0]).toContain('pr')
    expect(firstCall?.[0]).toContain(REPO)
  })

  it('throws when gh fails so scheduler can fail-safe', async () => {
    const gh = vi.fn(async () => { throw new Error('gh auth') })
    await expect(hasOpenPeanutPrForRepo(REPO, 'peanut/x', gh)).rejects.toThrow(/gh auth/)
  })
})

describe('claude implementer fixture', () => {
  it('checkout, runCoder change, peanut PR with issue link', async () => {
    const root = tempHome()
    const bare = path.join(root, 'remote.git')
    execSync(`git init --bare -b main ${JSON.stringify(bare)}`, { stdio: 'ignore' })
    const origin = path.join(root, 'origin')
    fs.mkdirSync(origin)
    execSync('git init -b main', { cwd: origin, env: { GIT_CONFIG_NOSYSTEM: '1' } })
    execSync('git config user.email t@t.com && git config user.name t', { cwd: origin })
    fs.writeFileSync(path.join(origin, 'package.json'), '{"name":"t","scripts":{"typecheck":"exit 0","test":"exit 0"}}\n')
    fs.writeFileSync(path.join(origin, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    execSync('git add -A && git commit -m seed', { cwd: origin })
    execSync(`git remote add origin ${JSON.stringify(bare)}`, { cwd: origin })
    execSync('git push -u origin main', { cwd: origin, env: { GIT_CONFIG_NOSYSTEM: '1' } })

    const gh = vi.fn(async (args: string[]) => {
      if (args[1] === 'list') return '[]'
      if (args[1] === 'create') return 'https://github.com/o/r/pull/9\n'
      if (args[1] === 'view') return JSON.stringify({ number: 9, url: 'https://github.com/o/r/pull/9' })
      return ''
    })

    const runner = createClaudeDispatchJobRunner({
      github: {
        enabled: true,
        repo: REPO,
        authorizedActors: ['LofiSu'],
        pollIntervalMs: 60_000,
        sourceRepo: origin,
      },
      gh,
      pushRemote: bare,
      holdout: () => undefined,
      runCoder: async ({ workspace }) => {
        fs.writeFileSync(path.join(workspace, 'fix.txt'), 'applied\n')
      },
    })

    const home = tempHome()
    const store = new Store(home)
    const job: DispatchJobDoc = {
      id: 'impl-9',
      type: 'github_fix',
      status: 'queued',
      createdAt: new Date().toISOString(),
      commentId: 'c9',
      issueNumber: 9,
      issueUrl: `https://github.com/${REPO}/issues/9`,
      issueTitle: 'fix me',
      issueBody: 'details',
    }
    store.putDoc('dispatch_job', job.id, job)
    await drainDispatchQueue({ store, runner })
    const done = store.getDoc<DispatchJobDoc>('dispatch_job', job.id)
    expect(done?.status).toBe('completed')
    expect(done?.prUrl).toContain('/pull/9')
    expect(gh).toHaveBeenCalled()
    store.close()
  })
})

describe('webhook verify', () => {
  it('returns false when secret is empty', () => {
    expect(verifyGithubWebhookSignature256('body', 'sha256=abc', '')).toBe(false)
    expect(verifyGithubWebhookSignature256('body', 'sha256=abc', '   ')).toBe(false)
  })
})

describe('implementer diff path policy', () => {
  it('refuses forbidden admission path on publish', async () => {
    const { assertImplementerDiffPolicy } = await import('../src/dispatch/diff-path-policy.ts')
    const root = tempHome()
    const ws = path.join(root, 'ws')
    fs.mkdirSync(ws)
    execSync('git init -b main', { cwd: ws, env: { GIT_CONFIG_NOSYSTEM: '1' } })
    execSync('git config user.email t@t.com && git config user.name t', { cwd: ws })
    fs.writeFileSync(path.join(ws, 'x.txt'), '1\n')
    execSync('git add x.txt && git commit -m seed', { cwd: ws })
    const base = execSync('git rev-parse HEAD', { cwd: ws, encoding: 'utf8' }).trim()
    fs.mkdirSync(path.join(ws, 'src/dispatch'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'src/dispatch/admission.ts'), 'export const x = 1\n')
    execSync('git add -A && git commit -m bad', { cwd: ws })
    expect(() => assertImplementerDiffPolicy(ws, base, 'github_fix')).toThrow(/forbidden/i)
  })

  it('refuses RSI lockfile and docs-only diffs', async () => {
    const { assertImplementerDiffPolicy } = await import('../src/dispatch/diff-path-policy.ts')
    const root = tempHome()
    const ws = path.join(root, 'ws')
    fs.mkdirSync(ws)
    execSync('git init -b main', { cwd: ws, env: { GIT_CONFIG_NOSYSTEM: '1' } })
    execSync('git config user.email t@t.com && git config user.name t', { cwd: ws })
    fs.writeFileSync(path.join(ws, 'note.md'), '1\n')
    execSync('git add note.md && git commit -m seed', { cwd: ws })
    const base = execSync('git rev-parse HEAD', { cwd: ws, encoding: 'utf8' }).trim()
    fs.writeFileSync(path.join(ws, 'note.md'), '2\n')
    expect(() => assertImplementerDiffPolicy(ws, base, 'rsi_implement')).toThrow(/docs\/prompts/i)
    execSync('git checkout -- note.md', { cwd: ws })
    fs.writeFileSync(path.join(ws, 'package.json'), '{}\n')
    execSync('git add package.json && git commit -m dep', { cwd: ws })
    expect(() => assertImplementerDiffPolicy(ws, base, 'rsi_implement')).toThrow(/dependency|lockfile/i)
  })

  it('refuses untracked forbidden workflow after git add (staged new path)', async () => {
    const { assertImplementerDiffPolicy } = await import('../src/dispatch/diff-path-policy.ts')
    const root = tempHome()
    const ws = path.join(root, 'ws')
    fs.mkdirSync(ws)
    execSync('git init -b main', { cwd: ws, env: { GIT_CONFIG_NOSYSTEM: '1' } })
    execSync('git config user.email t@t.com && git config user.name t', { cwd: ws })
    fs.writeFileSync(path.join(ws, 'x.txt'), '1\n')
    execSync('git add x.txt && git commit -m seed', { cwd: ws })
    const base = execSync('git rev-parse HEAD', { cwd: ws, encoding: 'utf8' }).trim()
    fs.mkdirSync(path.join(ws, '.github/workflows'), { recursive: true })
    fs.writeFileSync(path.join(ws, '.github/workflows/x.yml'), 'name: evil\n')
    execSync('git add -A', { cwd: ws, env: { GIT_CONFIG_NOSYSTEM: '1' } })
    expect(() => assertImplementerDiffPolicy(ws, base, 'github_fix')).toThrow(/github workflows|forbidden/i)
  })

  it('refuses RSI edits to scheduler modules', async () => {
    const { assertImplementerDiffPolicy } = await import('../src/dispatch/diff-path-policy.ts')
    const root = tempHome()
    const ws = path.join(root, 'ws')
    fs.mkdirSync(ws)
    execSync('git init -b main', { cwd: ws, env: { GIT_CONFIG_NOSYSTEM: '1' } })
    execSync('git config user.email t@t.com && git config user.name t', { cwd: ws })
    fs.mkdirSync(path.join(ws, 'src/dispatch'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'src/dispatch/queue.ts'), 'export const q = 1\n')
    execSync('git add -A && git commit -m seed', { cwd: ws })
    const base = execSync('git rev-parse HEAD', { cwd: ws, encoding: 'utf8' }).trim()
    fs.writeFileSync(path.join(ws, 'src/dispatch/queue.ts'), 'export const q = 2\n')
    execSync('git add -A', { cwd: ws, env: { GIT_CONFIG_NOSYSTEM: '1' } })
    expect(() => assertImplementerDiffPolicy(ws, base, 'rsi_implement')).toThrow(/dispatch queue|forbidden/i)
  })
})

describe('trusted-fetch redirects', () => {
  it('follows allowlisted https redirect and returns body', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        new Response('', { status: 302, headers: { Location: 'https://example.com/final' } }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const out = await trustedFetch('https://example.com/start', {
      allowHosts: ['example.com'],
      fetchImpl: fetchImpl as typeof fetch,
    })
    expect(out.body).toBe('ok')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('refuses redirect to private host', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response('', { status: 302, headers: { Location: 'https://127.0.0.1/x' } }),
    )
    await expect(
      trustedFetch('https://example.com/', {
        allowHosts: ['example.com', '127.0.0.1'],
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow(/private|allowlist/i)
  })

  it('refuses redirect to host outside allowlist', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response('', { status: 302, headers: { Location: 'https://evil.example/xx' } }),
    )
    await expect(
      trustedFetch('https://example.com/', {
        allowHosts: ['example.com'],
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow(/allowlist/i)
  })
})

describe('trusted-fetch SSRF', () => {
  const allow = ['example.com']
  const urls = [
    'http://127.0.0.1/',
    'https://127.0.0.1/',
    'https://127.0.0.2/',
    'https://0.0.0.0/',
    'https://localhost/',
    'https://10.0.0.1/',
    'https://169.254.169.254/',
    'file:///etc/passwd',
  ]
  for (const u of urls) {
    it(`refuses ${u}`, async () => {
      await expect(trustedFetch(u, { allowHosts: allow })).rejects.toThrow()
    })
  }

  it('refuses IPv4-mapped loopback host when allowlisted', async () => {
    await expect(trustedFetch('https://::ffff:127.0.0.1/', { allowHosts: ['::ffff:127.0.0.1'] })).rejects.toThrow()
  })

  it('refuses IPv4-mapped loopback hex when allowlisted (SSRF, not allowlist miss)', async () => {
    await expect(
      trustedFetch('https://[::ffff:7f00:1]/', { allowHosts: ['::ffff:7f00:1'] }),
    ).rejects.toThrow(/private|blocked/i)
  })

  it('refuses 0.1.2.3 in 0.0.0.0/8 when allowlisted', async () => {
    await expect(trustedFetch('https://0.1.2.3/', { allowHosts: ['0.1.2.3'] })).rejects.toThrow(/private|blocked/i)
  })

  it('refuses IPv6 unspecified when allowlisted', async () => {
    await expect(trustedFetch('https://[::]/', { allowHosts: ['::'] })).rejects.toThrow(/private|blocked/i)
  })
})

describe('RSI gap pool', () => {
  it('ingests with URL+fetched_at; high-risk stays proposal; low implements; idle on duplicate PR', async () => {
    const home = tempHome()
    const store = new Store(home)
    dispatchConfig(home)
    const cfg = loadDispatchOwnerConfigSync(home)!
    const gap = ingestGap(store, {
      title: 'Docs tweak',
      description: 'Add note',
      acceptance: 'Test passes',
      sourceUrl: 'https://docs.github.com/en',
      fetchedAt: '2026-11-15T00:00:00Z',
    }, p => store.nextId(p))!
    expect(gap.sourceUrl).toContain('docs.github.com')
    expect(gap.manusCue).toBe('unknown')

    const high = ingestGap(store, {
      title: 'Change sandbox network policy',
      description: 'widen network',
      acceptance: 'n/a',
      sourceUrl: 'https://docs.github.com/policy',
      fetchedAt: '2026-11-15T00:00:00Z',
      dedupeKey: 'high-1',
    }, p => store.nextId(p))!
    expect(classifyGapRisk(high.title, high.description)).toBe('high')
    expect(high.status).toBe('proposal')
    const proposalJob = store.listDocs<DispatchJobDoc>('dispatch_job').find(j => j.type === 'rsi_proposal')
    expect(proposalJob).toBeTruthy()

    cfg.rsi.intervalMs = 0
    const tick = await runRsiSchedulerTick(store, cfg, p => store.nextId(p), {
      fetchPage: async () => ({ body: 'ok', fetchedAt: '2026-11-15T12:00:00Z' }),
      hasOpenPeanutPr: async () => true,
      repoRoot: home,
    })
    expect(tick.idle).toBe(true)
    store.close()
  })

  it('instinct missing WhatsApp-like row is proposal-only and does not enqueue rsi_implement', async () => {
    const home = tempHome()
    const store = new Store(home)
    dispatchConfig(home)
    const cfg = loadDispatchOwnerConfigSync(home)!
    cfg.rsi.intervalMs = 0
    const docDir = path.join(home, 'docs')
    fs.mkdirSync(docDir)
    fs.writeFileSync(path.join(docDir, 'INSTINCT_CAPABILITIES.md'), [
      '| # | 能力项 | Instinct 公开证据 | 等级 | ds-agent 状态 | 本仓库路径 / 验收依据 |',
      '|---|---|---|---|---|---|',
      '| A2 | WhatsApp 入口 | evidence | teardown | `missing` | path notes |',
    ].join('\n'))
    const tick = await runRsiSchedulerTick(store, cfg, p => store.nextId(p), {
      fetchPage: async () => ({ body: 'ok', fetchedAt: '2026-11-15T12:00:00Z' }),
      repoRoot: home,
    })
    expect(tick.idle).toBe(true)
    const impl = store.listDocs<DispatchJobDoc>('dispatch_job').filter(j => j.type === 'rsi_implement')
    expect(impl).toHaveLength(0)
    const gaps = store.listDocs<DispatchGapDoc>('dispatch_gap')
    expect(gaps.some(g => g.status === 'proposal')).toBe(true)
    store.close()
  })

  it('instinct C2-style disclaimer evidence is proposal-only and does not enqueue rsi_implement', async () => {
    const c2Evidence =
      '名称数量不是验收标准。本仓库 tool surface 是 `src/harness/tools.ts` 的显式 tool list，远小于 Instinct 的 CLI grammar；不要用“577”当能力声明'
    expect(acceptanceFromInstinctEvidenceColumn(c2Evidence)).toBe('')

    const home = tempHome()
    const store = new Store(home)
    dispatchConfig(home)
    const cfg = loadDispatchOwnerConfigSync(home)!
    cfg.rsi.intervalMs = 0
    const docDir = path.join(home, 'docs')
    fs.mkdirSync(docDir)
    fs.writeFileSync(path.join(docDir, 'INSTINCT_CAPABILITIES.md'), [
      '| # | 能力项 | Instinct 公开证据 | 等级 | ds-agent 状态 | 本仓库路径 / 验收依据 |',
      '|---|---|---|---|---|---|',
      `| C2 | 工具/动作总量口径 | S4/S5 evidence | teardown | \`missing\`（无可比 surface） | ${c2Evidence} |`,
    ].join('\n'))
    const tick = await runRsiSchedulerTick(store, cfg, p => store.nextId(p), {
      fetchPage: async () => ({ body: 'ok', fetchedAt: '2026-11-15T12:00:00Z' }),
      hasOpenPeanutPr: async () => false,
      repoRoot: home,
    })
    expect(tick.idle).toBe(true)
    const gaps = store.listDocs<DispatchGapDoc>('dispatch_gap')
    const c2 = gaps.find(g => g.title.includes('工具/动作总量口径'))
    expect(c2).toBeTruthy()
    expect(c2!.acceptance).toBe('')
    expect(c2!.status).toBe('proposal')
    expect(isImplementableLowRiskGap(c2!)).toBe(false)
    const impl = store.listDocs<DispatchJobDoc>('dispatch_job').filter(j => j.type === 'rsi_implement')
    expect(impl).toHaveLength(0)
    store.close()
  })

  it('competitive gap Behind verdict ingests proposal and does not enqueue rsi_implement', async () => {
    const home = tempHome()
    const store = new Store(home)
    dispatchConfig(home)
    const cfg = loadDispatchOwnerConfigSync(home)!
    cfg.rsi.intervalMs = 0
    const docDir = path.join(home, 'docs')
    fs.mkdirSync(docDir)
    fs.writeFileSync(path.join(docDir, 'COMPETITIVE_GAP.md'), [
      '| Dimension | Instinct / Open Instinct | Muse | Grok Bot | ds-agent now | Verdict |',
      '|---|---|---|---|---|---|',
      '| **Owner model** | tiers | single | one | single owner | **Behind** on tiers; ahead on ingress |',
    ].join('\n'))
    const created = ingestCompetitiveGapFromFile(store, home, p => store.nextId(p))
    expect(created).toHaveLength(1)
    expect(created[0]!.status).toBe('proposal')
    expect(created[0]!.acceptance).toBe('')
    expect(created[0]!.manusCue).toBe('unknown')
    expect(created[0]!.sourceUrl).toContain('COMPETITIVE_GAP.md')
    const tick = await runRsiSchedulerTick(store, cfg, p => store.nextId(p), {
      fetchPage: async () => ({ body: 'ok', fetchedAt: '2026-11-15T12:00:00Z' }),
      hasOpenPeanutPr: async () => false,
      repoRoot: home,
    })
    expect(tick.idle).toBe(true)
    const impl = store.listDocs<DispatchJobDoc>('dispatch_job').filter(j => j.type === 'rsi_implement')
    expect(impl).toHaveLength(0)
    store.close()
  })

  it('rsi_proposal job does not invoke implementer hooks', async () => {
    const home = tempHome()
    const store = new Store(home)
    const rsiImpl = vi.fn()
    const runner = createJobRunner({
      rsiImplement: rsiImpl as never,
    })
    store.putDoc('dispatch_job', 'prop', {
      id: 'prop',
      type: 'rsi_proposal',
      status: 'queued',
      createdAt: new Date().toISOString(),
      commentId: 'gap-x',
      gapId: 'gap-x',
    } satisfies DispatchJobDoc)
    await drainDispatchQueue({ store, runner })
    expect(rsiImpl).not.toHaveBeenCalled()
    expect(store.getDoc<DispatchJobDoc>('dispatch_job', 'prop')?.status).toBe('completed')
    store.close()
  })

  it('low-risk gap with acceptance enqueues rsi_implement once', async () => {
    const home = tempHome()
    const store = new Store(home)
    dispatchConfig(home)
    const cfg = loadDispatchOwnerConfigSync(home)!
    cfg.rsi.intervalMs = 0
    const gap = ingestGap(store, {
      title: 'Small helper export',
      description: 'Add typed export',
      acceptance: 'test/foo.test.ts passes in offline holdout.',
      sourceUrl: 'file://docs/x.md',
      fetchedAt: '2026-11-15T00:00:00Z',
      dedupeKey: 'low-1',
    }, p => store.nextId(p))!
    expect(gap.risk).toBe('low')
    const tick = await runRsiSchedulerTick(store, cfg, p => store.nextId(p), {
      fetchPage: async () => ({ body: 'ok', fetchedAt: '2026-11-15T12:00:00Z' }),
      hasOpenPeanutPr: async () => false,
      repoRoot: home,
    })
    expect(tick.idle).toBe(false)
    const impl = store.listDocs<DispatchJobDoc>('dispatch_job').filter(j => j.type === 'rsi_implement')
    expect(impl).toHaveLength(1)
    store.close()
  })

  it('homepage snapshot fetch does not enqueue rsi_implement', async () => {
    const home = tempHome()
    const store = new Store(home)
    dispatchConfig(home)
    const cfg = loadDispatchOwnerConfigSync(home)!
    cfg.rsi.intervalMs = 0
    const tick = await runRsiSchedulerTick(store, cfg, p => store.nextId(p), {
      fetchPage: async () => ({ body: '<html>homepage</html>', fetchedAt: '2026-11-15T12:00:00Z' }),
      repoRoot: home,
    })
    expect(tick.idle).toBe(true)
    const impl = store.listDocs<DispatchJobDoc>('dispatch_job').filter(j => j.type === 'rsi_implement')
    expect(impl).toHaveLength(0)
    const cache = store.getDoc(RSI_RESEARCH_CACHE_KIND, 'host:docs.github.com')
    expect(cache).toBeTruthy()
    store.close()
  })

  it('records rsi.sourceUrls fetch success and failure in research cache', async () => {
    const home = tempHome()
    const store = new Store(home)
    const src = 'https://docs.github.com/en/actions'
    dispatchConfig(home, {
      rsi: {
        enabled: true,
        intervalMs: 0,
        sourceUrls: [src, 'https://docs.github.com/bad-path'],
      },
    })
    const cfg = loadDispatchOwnerConfigSync(home)!
    cfg.rsi.intervalMs = 0
    let call = 0
    const tick = await runRsiSchedulerTick(store, cfg, p => store.nextId(p), {
      fetchPage: async url => {
        call += 1
        if (url === src) {
          return { body: 'actions-doc', fetchedAt: '2026-11-15T13:00:00Z' }
        }
        throw new Error('simulated 404')
      },
      repoRoot: home,
    })
    expect(tick.idle).toBe(true)
    expect(call).toBeGreaterThanOrEqual(2)
    const okCache = store.getDoc(RSI_RESEARCH_CACHE_KIND, `url:${src}`)
    expect(okCache).toMatchObject({ ok: true, body: 'actions-doc', url: src })
    const failCache = store.getDoc(
      RSI_RESEARCH_CACHE_KIND,
      'url:https://docs.github.com/bad-path',
    )
    expect(failCache).toMatchObject({ ok: false, error: 'simulated 404' })
    store.close()
  })
})

describe('rsi implementer fixture', () => {
  it('isolated implement publishes peanut PR with source and acceptance', async () => {
    const root = tempHome()
    const bare = path.join(root, 'remote.git')
    execSync(`git init --bare -b main ${JSON.stringify(bare)}`, { stdio: 'ignore' })
    const origin = path.join(root, 'origin')
    fs.mkdirSync(origin)
    execSync('git init -b main', { cwd: origin, env: { GIT_CONFIG_NOSYSTEM: '1' } })
    execSync('git config user.email t@t.com && git config user.name t', { cwd: origin })
    fs.writeFileSync(path.join(origin, 'package.json'), JSON.stringify({
      name: 't',
      scripts: { typecheck: 'exit 0', test: 'exit 0' },
    }) + '\n')
    execSync('git add -A && git commit -m seed', { cwd: origin })
    execSync(`git remote add origin ${JSON.stringify(bare)}`, { cwd: origin })
    execSync('git push -u origin main', { cwd: origin, env: { GIT_CONFIG_NOSYSTEM: '1' } })

    let prBody = ''
    const gh = vi.fn(async (args: string[]) => {
      if (args[1] === 'create') {
        const i = args.indexOf('--body')
        if (i >= 0) prBody = args[i + 1] ?? ''
      }
      if (args[1] === 'list') return '[]'
      if (args[1] === 'create') return 'https://github.com/o/r/pull/11\n'
      if (args[1] === 'view') return JSON.stringify({ number: 11, url: 'https://github.com/o/r/pull/11' })
      return ''
    })

    const runner = createClaudeDispatchJobRunner({
      github: {
        enabled: true,
        repo: REPO,
        authorizedActors: ['LofiSu'],
        pollIntervalMs: 60_000,
        sourceRepo: origin,
        implementer: 'claude',
      },
      gh,
      pushRemote: bare,
      holdout: () => undefined,
      runRsiCoder: async ({ workspace }) => {
        fs.writeFileSync(path.join(workspace, 'rsi-fix.txt'), 'gap\n')
      },
    })

    const home = tempHome()
    const store = new Store(home)
    const gap: DispatchGapDoc = {
      id: 'gap_low',
      title: 'Helper tweak',
      description: 'd',
      acceptance: 'Unit tests pass.',
      risk: 'low',
      priority: 10,
      sourceUrl: 'file://docs/INSTINCT_CAPABILITIES.md',
      fetchedAt: '2026-11-16T00:00:00Z',
      manusCue: 'unknown',
      status: 'open',
      dedupeKey: 'k-low',
    }
    store.putDoc('dispatch_gap', gap.id, gap)
    store.putDoc('dispatch_job', 'rsi-1', {
      id: 'rsi-1',
      type: 'rsi_implement',
      status: 'queued',
      createdAt: new Date().toISOString(),
      commentId: 'gap-impl-gap_low',
      gapId: gap.id,
    } satisfies DispatchJobDoc)
    await drainDispatchQueue({ store, runner })
    expect(store.getDoc<DispatchJobDoc>('dispatch_job', 'rsi-1')?.status).toBe('completed')
    expect(prBody).toContain('sourceUrl')
    expect(prBody).toContain(gap.acceptance)
    expect(prBody).toMatch(/manusCue.*unknown/i)
    store.close()
  })

  it('holdout failure leaves job failed without publish', async () => {
    const root = tempHome()
    const origin = path.join(root, 'origin')
    fs.mkdirSync(origin)
    execSync('git init -b main', { cwd: origin, env: { GIT_CONFIG_NOSYSTEM: '1' } })
    execSync('git config user.email t@t.com && git config user.name t', { cwd: origin })
    fs.writeFileSync(path.join(origin, 'package.json'), '{"name":"t"}\n')
    execSync('git add -A && git commit -m seed', { cwd: origin })

    const gh = vi.fn()
    const runner = createClaudeDispatchJobRunner({
      github: {
        enabled: true,
        repo: REPO,
        authorizedActors: ['LofiSu'],
        pollIntervalMs: 60_000,
        sourceRepo: origin,
      },
      gh,
      holdout: (_w, label) => {
        if (label === 'publish') throw new Error('holdout failed')
      },
      runRsiCoder: async ({ workspace }) => {
        fs.writeFileSync(path.join(workspace, 'x'), 'y\n')
      },
    })

    const home = tempHome()
    const store = new Store(home)
    store.putDoc('dispatch_gap', 'gap_fail', {
      id: 'gap_fail',
      title: 't',
      description: 'd',
      acceptance: 'tests pass',
      risk: 'low',
      priority: 10,
      sourceUrl: 'file://x',
      fetchedAt: '2026-11-16T00:00:00Z',
      manusCue: 'unknown',
      status: 'open',
      dedupeKey: 'kf',
    } satisfies DispatchGapDoc)
    store.putDoc('dispatch_job', 'j-fail', {
      id: 'j-fail',
      type: 'rsi_implement',
      status: 'queued',
      createdAt: new Date().toISOString(),
      commentId: 'c',
      gapId: 'gap_fail',
    } satisfies DispatchJobDoc)
    await drainDispatchQueue({ store, runner })
    expect(store.getDoc<DispatchJobDoc>('dispatch_job', 'j-fail')?.status).toBe('failed')
    expect(gh).not.toHaveBeenCalled()
    store.close()
  })

  it('forbidden path edit refuses publish', async () => {
    const root = tempHome()
    const origin = path.join(root, 'origin')
    fs.mkdirSync(origin)
    execSync('git init -b main', { cwd: origin, env: { GIT_CONFIG_NOSYSTEM: '1' } })
    execSync('git config user.email t@t.com && git config user.name t', { cwd: origin })
    fs.mkdirSync(path.join(origin, 'src/dispatch'), { recursive: true })
    fs.writeFileSync(path.join(origin, 'src/dispatch/admission.ts'), 'export const ok = true\n')
    fs.writeFileSync(path.join(origin, 'package.json'), '{"name":"t"}\n')
    execSync('git add -A && git commit -m seed', { cwd: origin })

    const gh = vi.fn()
    const runner = createClaudeDispatchJobRunner({
      github: {
        enabled: true,
        repo: REPO,
        authorizedActors: ['LofiSu'],
        pollIntervalMs: 60_000,
        sourceRepo: origin,
      },
      gh,
      holdout: () => undefined,
      runRsiCoder: async ({ workspace }) => {
        fs.writeFileSync(path.join(workspace, 'src/dispatch/admission.ts'), 'export const ok = false\n')
      },
    })

    const home = tempHome()
    const store = new Store(home)
    store.putDoc('dispatch_gap', 'g2', {
      id: 'g2',
      title: 't',
      description: 'd',
      acceptance: 'a',
      risk: 'low',
      priority: 10,
      sourceUrl: 'file://x',
      fetchedAt: '2026-11-16T00:00:00Z',
      manusCue: 'unknown',
      status: 'open',
      dedupeKey: 'k2',
    } satisfies DispatchGapDoc)
    store.putDoc('dispatch_job', 'j2', {
      id: 'j2',
      type: 'rsi_implement',
      status: 'queued',
      createdAt: new Date().toISOString(),
      commentId: 'c2',
      gapId: 'g2',
    } satisfies DispatchJobDoc)
    await drainDispatchQueue({ store, runner })
    expect(store.getDoc<DispatchJobDoc>('dispatch_job', 'j2')?.status).toBe('failed')
    expect(gh).not.toHaveBeenCalled()
    store.close()
  })
})


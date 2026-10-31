import { describe, expect, it } from 'vitest'
import {
  GhCliApi,
  GithubIssueSource,
  GithubOutboxAdapter,
  githubCommentTrigger,
  githubIssueTrigger,
  parseRepo,
  runGh,
  type GithubApi,
  type GithubComment,
  type GithubIssue,
} from '../src/channels/github-source.ts'
import type { OutboxRow } from '../src/shared/types.ts'

const repo = parseRepo('LofiSu/deepseek-super-agent')

const issue: GithubIssue = {
  id: 9001,
  number: 42,
  title: 'CI failed on auth test',
  body: '@ds-agent please investigate the login timeout.',
  state: 'open',
  html_url: 'https://github.com/LofiSu/deepseek-super-agent/issues/42',
  created_at: '2026-11-01T01:00:00Z',
  user: { id: 1, login: 'LofiSu', type: 'User' },
}

const comments: GithubComment[] = [
  {
    id: 5002,
    body: 'follow-up without the agent mention',
    html_url: 'https://github.com/LofiSu/deepseek-super-agent/issues/42#issuecomment-5002',
    created_at: '2026-11-01T01:02:00Z',
    user: { id: 1, login: 'LofiSu', type: 'User' },
  },
  {
    id: 5001,
    body: '@ds-agent login still 500',
    html_url: 'https://github.com/LofiSu/deepseek-super-agent/issues/42#issuecomment-5001',
    created_at: '2026-11-01T01:01:00Z',
    user: { id: 2, login: 'ci-bot', type: 'Bot' },
  },
]

class FakeGithub implements GithubApi {
  posted: { number: number; body: string }[] = []
  requests: string[] = []

  async createIssue(): Promise<GithubIssue> { return issue }
  async getIssue(number: number): Promise<GithubIssue> {
    this.requests.push(`GET issue ${number}`)
    return { ...issue, number }
  }
  async updateIssue(number: number, patch: { state?: 'open' | 'closed' }): Promise<GithubIssue> {
    this.requests.push(`PATCH issue ${number} ${patch.state ?? ''}`)
    return { ...issue, number, state: patch.state ?? 'open' }
  }
  async listIssueComments(number: number): Promise<GithubComment[]> {
    this.requests.push(`GET comments ${number}`)
    return [...comments]
  }
  async createIssueComment(number: number, body: string): Promise<GithubComment> {
    this.posted.push({ number, body })
    return { id: 7777, body, created_at: new Date().toISOString(), user: { login: 'LofiSu', type: 'User' } }
  }
  async getIssueComment(id: number): Promise<GithubComment> {
    return { id, body: this.posted.at(-1)?.body ?? '', created_at: new Date().toISOString() }
  }
  async request<T>(): Promise<T> { return undefined as T }
}

function outboxRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 'outbox_1',
    replyId: 'reply_1',
    ticketId: 'ticket_1',
    channel: 'github',
    thread: 'issue:42',
    target: { provider: 'github', repo: repo.full, issue: '42' },
    text: 'ds-agent note\n\nticket: ticket_1',
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('real GitHub source mapping', () => {
  it('parses owner/name and rejects malformed repos', () => {
    expect(repo).toEqual({ owner: 'LofiSu', repo: 'deepseek-super-agent', full: 'LofiSu/deepseek-super-agent' })
    expect(() => parseRepo('not-a-repo')).toThrow(/owner\/name/)
  })

  it('maps a real issue body to a github Trigger without synthesizing text', () => {
    const trigger = githubIssueTrigger(repo, issue)
    expect(trigger.id).toBe('gh_issue_9001_body')
    expect(trigger.source).toBe('github')
    expect(trigger.threads).toEqual([{ source: 'github', id: 'issue:42' }])
    expect(trigger.actor).toEqual({ source: 'github', id: 'LofiSu' })
    expect(trigger.human).toBe(true)
    expect(trigger.addressed).toBe('mention')
    expect(trigger.at).toBe('2026-11-01T01:00:00Z')
    expect(trigger.text).toContain('CI failed on auth test')
    expect(trigger.text).toContain('@ds-agent please investigate')
    expect(trigger.channel?.address).toMatchObject({ provider: 'github', repo: repo.full, issue: '42' })
    expect(trigger.meta).toMatchObject({ repo: repo.full, issue: 42, kind: 'issue' })
  })

  it('maps real comments, keeps bot actors non-human, and preserves API ids', () => {
    const trigger = githubCommentTrigger(repo, issue, comments[1]!)
    expect(trigger.id).toBe('gh_comment_5001')
    expect(trigger.actor.id).toBe('ci-bot')
    expect(trigger.human).toBe(false)
    expect(trigger.text).toBe('@ds-agent login still 500')
    expect(trigger.meta).toMatchObject({ commentId: 5001, kind: 'comment' })
  })

  it('pulls the issue plus comments in create-time order', async () => {
    const fake = new FakeGithub()
    const source = new GithubIssueSource(fake, repo, 42)
    const pull = await source.pull()
    expect(fake.requests).toEqual(['GET issue 42', 'GET comments 42'])
    expect(pull.triggers.map(trigger => trigger.id)).toEqual([
      'gh_issue_9001_body',
      'gh_comment_5001',
      'gh_comment_5002',
    ])
    expect(pull.triggers.map(trigger => trigger.text)).toEqual([
      `${issue.title}\n\n${issue.body}`,
      '@ds-agent login still 500',
      'follow-up without the agent mention',
    ])
  })

  it('pulls are idempotent: repeated polls produce the same trigger ids', async () => {
    const fake = new FakeGithub()
    const source = new GithubIssueSource(fake, repo, 42)
    const first = await source.pull()
    const second = await source.pull()
    expect(second.triggers.map(trigger => trigger.id)).toEqual(first.triggers.map(trigger => trigger.id))
  })

  it('posts the outbox row as a real issue comment', async () => {
    const fake = new FakeGithub()
    const adapter = new GithubOutboxAdapter(fake)
    const result = await adapter.send(outboxRow())
    expect(result.externalId).toBe('7777')
    expect(fake.posted).toEqual([{ number: 42, body: 'ds-agent note\n\nticket: ticket_1' }])
  })

  it('refuses an outbox row without an issue target', async () => {
    const fake = new FakeGithub()
    const adapter = new GithubOutboxAdapter(fake)
    await expect(adapter.send(outboxRow({ target: { repo: repo.full } }))).rejects.toThrow(/target\.issue/)
  })
})

describe('gh api invocation', () => {
  it('uses --input - for JSON bodies instead of shell quoting', async () => {
    const calls: { args: string[]; input?: string }[] = []
    const fakeRun = async (args: string[], input?: string) => {
      calls.push({ args, input })
      return '{"id":1}'
    }
    const api = new GhCliApi(repo, fakeRun)
    await api.createIssueComment(42, 'line one\nline two "quoted"')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toContain('--input')
    expect(JSON.parse(calls[0]!.input!)).toEqual({ body: 'line one\nline two "quoted"' })
  })

  it('surfaces gh failures instead of pretending success', async () => {
    const fakeRun = async () => { throw new Error('gh auth login required') }
    const api = new GhCliApi(repo, fakeRun)
    await expect(api.getIssue(1)).rejects.toThrow(/gh auth login required/)
  })

  it('runGh is exported as the production runner', () => {
    expect(typeof runGh).toBe('function')
  })
})

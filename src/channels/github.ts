import type { OutboundMessage, ReplyKind } from '../shared/types.js'
import { AgentError } from '../shared/errors.js'
import { assertReply, formatReply, type NormalizedInbound } from './norm.js'

export interface GhComment {
  user: string
  body: string
  kind?: ReplyKind
}

export interface GhIssue {
  number: number
  title: string
  comments: GhComment[]
}

/** In-memory issues and comments. Not a GitHub API client. */
export class FakeGithubChannel {
  readonly kind = 'github' as const
  readonly issues = new Map<number, GhIssue>()

  open(number: number, title: string): GhIssue {
    const issue: GhIssue = { number, title, comments: [] }
    this.issues.set(number, issue)
    return issue
  }

  comment(number: number, user: string, body: string, at = new Date().toISOString()): NormalizedInbound {
    const issue = this.issue(number)
    issue.comments.push({ user, body })
    return {
      source: this.kind,
      threadId: String(number),
      actorId: user,
      human: !user.endsWith('[bot]'),
      text: body,
      at,
      address: { issue: String(number) },
    }
  }

  deliver(message: OutboundMessage): void {
    assertReply(message)
    const number = Number(message.channel.address.issue ?? message.channel.thread)
    const issue = this.issue(number)
    issue.comments.push({ user: 'ds-agent', body: formatReply(message), kind: message.kind })
  }

  private issue(number: number): GhIssue {
    const issue = this.issues.get(number)
    if (!issue) throw new AgentError('channel_missing', `github issue ${number} not found`)
    return issue
  }
}

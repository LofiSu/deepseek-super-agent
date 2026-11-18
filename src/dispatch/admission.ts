import { parseRepo, type GithubComment, type GithubIssue, type GithubUser } from '../channels/github-source.ts'

export type DispatchCommand = 'fix' | 'status' | 'cancel'

export interface DispatchAdmissionInput {
  configuredRepo: string
  authorizedActors: string[]
  /** Verified mention handles (no @); when set, @handle command lines are allowed. */
  mentionHandles?: string[]
  repoFullFromPayload: string
  issue: GithubIssue & { pull_request?: unknown }
  comment: GithubComment
}

export interface DispatchIssueBodyAdmissionInput {
  configuredRepo: string
  authorizedActors: string[]
  mentionHandles?: string[]
  repoFullFromPayload: string
  issue: GithubIssue & { pull_request?: unknown }
  /** Cursor seededAt — issue created_at must be >= this. */
  seededAt: string
}

export interface DispatchAdmissionOk {
  ok: true
  command: DispatchCommand
  actorLogin: string
}

export interface DispatchAdmissionReject {
  ok: false
  reason: string
}

export type DispatchAdmissionResult = DispatchAdmissionOk | DispatchAdmissionReject

const SLASH_COMMAND_RE = /^\/ds-agent\s+(fix|status|cancel)\b/i

const MENTION_COMMAND_RE =
  /^@(?<handle>[\w.-]+)\s+(?:\/ds-agent\s+)?(?<cmd>fix|status|cancel)\b/i

/** Strip fenced blocks, inline code, and blockquotes before command detection. */
export function stripNonCommandRegions(body: string): string {
  let text = body
  text = text.replace(/```[\s\S]*?```/g, '\n')
  text = text.replace(/`[^`\n]*`/g, ' ')
  const lines: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('>')) continue
    lines.push(line)
  }
  return lines.join('\n')
}

function mentionAllowed(handle: string, mentionHandles: readonly string[] | undefined): boolean {
  if (!mentionHandles?.length) return false
  const h = handle.toLowerCase()
  return mentionHandles.some(m => m.replace(/^@/, '').toLowerCase() === h)
}

export function parseDispatchCommand(
  body: string | null | undefined,
  mentionHandles?: readonly string[],
): DispatchCommand | undefined {
  const stripped = stripNonCommandRegions(body ?? '')
  for (const line of stripped.split(/\r?\n/)) {
    const trimmed = line.trim()
    const slash = SLASH_COMMAND_RE.exec(trimmed)
    if (slash) return slash[1]!.toLowerCase() as DispatchCommand
    const mention = MENTION_COMMAND_RE.exec(trimmed)
    if (mention?.groups?.handle && mention.groups.cmd
      && mentionAllowed(mention.groups.handle, mentionHandles)) {
      return mention.groups.cmd.toLowerCase() as DispatchCommand
    }
  }
  return undefined
}

export function loginAuthorized(authorized: readonly string[], login: string | undefined): boolean {
  if (!login?.trim()) return false
  const want = login.trim().toLowerCase()
  return authorized.some(a => a.trim().toLowerCase() === want)
}

export function isBotUser(user: GithubUser | null | undefined): boolean {
  if (!user) return true
  if (user.type === 'Bot') return true
  const login = user.login ?? ''
  if (/\[bot\]$/i.test(login)) return true
  return false
}

function admitDispatchCore(
  input: {
    configuredRepo: string
    authorizedActors: string[]
    mentionHandles?: string[]
    repoFullFromPayload: string
    issue: GithubIssue & { pull_request?: unknown }
    body: string | null | undefined
    actorLogin: string
    actorUser: GithubUser | null | undefined
  },
): DispatchAdmissionResult {
  let configured: string
  let payloadRepo: string
  try {
    configured = parseRepo(input.configuredRepo).full
    payloadRepo = parseRepo(input.repoFullFromPayload).full
  } catch {
    return { ok: false, reason: 'invalid repo name' }
  }
  if (configured !== payloadRepo) {
    return { ok: false, reason: 'repo mismatch' }
  }
  if (input.issue.pull_request != null) {
    return { ok: false, reason: 'pull request comment' }
  }
  if (isBotUser(input.actorUser)) {
    return { ok: false, reason: 'bot author' }
  }
  if (!loginAuthorized(input.authorizedActors, input.actorLogin)) {
    return { ok: false, reason: 'unauthorized actor' }
  }
  const command = parseDispatchCommand(input.body, input.mentionHandles)
  if (!command) {
    return { ok: false, reason: 'no allowed command' }
  }
  return { ok: true, command, actorLogin: input.actorLogin }
}

/**
 * Fail-closed admission for GitHub issue comments. Issue text is never authority
 * over repo, actors, or policy.
 */
export function admitDispatchComment(input: DispatchAdmissionInput): DispatchAdmissionResult {
  return admitDispatchCore({
    configuredRepo: input.configuredRepo,
    authorizedActors: input.authorizedActors,
    mentionHandles: input.mentionHandles,
    repoFullFromPayload: input.repoFullFromPayload,
    issue: input.issue,
    body: input.comment.body,
    actorLogin: input.comment.user?.login ?? '',
    actorUser: input.comment.user,
  })
}

/** Admit command in issue body (dedupe id issue-body:<issue.id>). */
export function admitDispatchIssueBody(input: DispatchIssueBodyAdmissionInput): DispatchAdmissionResult {
  if (input.issue.created_at < input.seededAt) {
    return { ok: false, reason: 'historical issue' }
  }
  return admitDispatchCore({
    configuredRepo: input.configuredRepo,
    authorizedActors: input.authorizedActors,
    mentionHandles: input.mentionHandles,
    repoFullFromPayload: input.repoFullFromPayload,
    issue: input.issue,
    body: input.issue.body,
    actorLogin: input.issue.user?.login ?? '',
    actorUser: input.issue.user,
  })
}

/** Reject forged policy in JSON payloads (tests / poll layer). */
export function rejectInjectedPolicyFields(payload: Record<string, unknown>): string | undefined {
  const forbidden = ['authorizedActors', 'authorized_actors', 'repo', 'mentionHandles', 'merge', 'force']
  for (const key of forbidden) {
    if (key in payload && payload[key] !== undefined) return `forbidden override field: ${key}`
  }
  return undefined
}

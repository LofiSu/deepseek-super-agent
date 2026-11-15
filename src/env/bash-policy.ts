import { UserError } from '../shared/errors.ts'

/** Protected branch names — no direct push or merge into these via dev shells. */
export const PROTECTED_BRANCHES = new Set(['main', 'master'])

/**
 * Returns a rejection reason when a non-isolated dev shell must not run `command`.
 * Pure text analysis; returns `null` when allowed.
 */
export function devShellCommandRejection(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null

  if (rejectsGhPrMerge(trimmed)) {
    return 'dev shell policy: gh pr merge is not allowed (use a PR and owner/orchestrator merge)'
  }
  if (rejectsGitPushToProtected(trimmed)) {
    return 'dev shell policy: git push to main/master is not allowed'
  }
  if (rejectsCheckoutThenMergeIntoProtected(trimmed)) {
    return 'dev shell policy: merge or rebase onto main/master is not allowed'
  }
  return null
}

export function assertDevShellCommandAllowed(command: string): void {
  const reason = devShellCommandRejection(command)
  if (reason) throw new UserError(reason)
}

/** Split on `;`, `&&`, `||`, and newlines — enough for common compound commands. */
export function splitShellStatements(command: string): string[] {
  const parts: string[] = []
  let current = ''
  let i = 0
  while (i < command.length) {
    const ch = command[i]
    if (ch === '\n' || ch === ';') {
      parts.push(current)
      current = ''
      i += 1
      continue
    }
    if (ch === '&' && command[i + 1] === '&') {
      parts.push(current)
      current = ''
      i += 2
      continue
    }
    if (ch === '|' && command[i + 1] === '|') {
      parts.push(current)
      current = ''
      i += 2
      continue
    }
    current += ch
    i += 1
  }
  parts.push(current)
  return parts.map(p => p.trim()).filter(Boolean)
}

function rejectsGhPrMerge(command: string): boolean {
  return splitShellStatements(command).some(stmt => /\bgh\s+pr\s+merge\b/.test(stmt))
}

function rejectsGitPushToProtected(command: string): boolean {
  return splitShellStatements(command).some(stmt => {
    if (!/\bgit\s+push\b/.test(stmt)) return false
    return gitPushStatementTargetsProtected(stmt)
  })
}

/**
 * Detect refspecs and branch args that update main/master on a remote.
 * Allows `git push origin feature/foo` and local bare remotes on feature branches.
 */
export function gitPushStatementTargetsProtected(statement: string): boolean {
  const tokens = tokenizeSimple(statement)
  const pushIdx = tokens.findIndex((t, i) => t === 'push' && i > 0 && tokens[i - 1] === 'git')
  if (pushIdx < 0) return false

  const afterPush = tokens.slice(pushIdx + 1).filter(t => !t.startsWith('-'))
  const refspecs: string[] = []
  let skippedRemote = false
  for (const arg of afterPush) {
    if (!skippedRemote && looksLikeRemoteName(arg)) {
      skippedRemote = true
      continue
    }
    refspecs.push(arg)
  }
  if (refspecs.length === 0) return false

  return refspecs.some(refspec => refspecTargetsProtectedBranch(refspec))
}

function looksLikeRemoteName(arg: string): boolean {
  if (arg.includes(':') || arg.includes('/') || arg === '.' || arg === 'HEAD') return false
  return /^[\w.-]+$/.test(arg)
}

export function refspecTargetsProtectedBranch(refspec: string): boolean {
  const normalized = refspec.replace(/^\+/, '').trim()
  if (!normalized) return false

  if (normalized.startsWith(':')) {
    return protectedRefName(normalized.slice(1))
  }

  const colon = normalized.indexOf(':')
  if (colon >= 0) {
    const dest = normalized.slice(colon + 1)
    return protectedRefName(dest)
  }

  return protectedRefName(normalized)
}

export function protectedRefName(ref: string): boolean {
  const r = ref.trim()
  if (r === 'HEAD') return false
  const branch = r
    .replace(/^refs\/heads\//, '')
    .replace(/^origin\//, '')
    .split('/')[0]
  return PROTECTED_BRANCHES.has(branch)
}

function rejectsCheckoutThenMergeIntoProtected(command: string): boolean {
  const stmts = splitShellStatements(command)
  let checkedOutProtected = false
  for (const stmt of stmts) {
    if (/\bgit\s+checkout\s+(?:-\w+\s+)*(?:main|master)\b/.test(stmt)
      || /\bgit\s+switch\s+(?:-\w+\s+)*(?:main|master)\b/.test(stmt)) {
      checkedOutProtected = true
      continue
    }
    if (!checkedOutProtected) continue
    if (/\bgit\s+merge\b/.test(stmt)) return true
    if (/\bgit\s+rebase\b/.test(stmt)) return true
  }
  return false
}

function tokenizeSimple(statement: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let quote: "'" | '"' | null = null
  for (let i = 0; i < statement.length; i += 1) {
    const c = statement[i]
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      continue
    }
    if (/\s/.test(c)) {
      if (cur) {
        tokens.push(cur)
        cur = ''
      }
      continue
    }
    cur += c
  }
  if (cur) tokens.push(cur)
  return tokens
}


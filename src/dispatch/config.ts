import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_GITHUB_REPO, parseRepo, runGh, type GhRun } from '../channels/github-source.ts'
import {
  bootstrapDispatchGithubAuth,
  parseGithubAuthBlock,
  type DispatchHostGithubAuth,
  type GithubDispatchAuthConfig,
} from './github-app-auth.ts'
import { UserError } from '../shared/errors.ts'

export const GITHUB_DISPATCH_FILE = 'github-dispatch.json'

/** Public user we do not own; never accept as default mention identity. */
export const UNOWNED_PUBLIC_HANDLE = 'ds-agent'

export interface GithubDispatchConfig {
  enabled: boolean
  repo: string
  /** GitHub logins, case-insensitive exact match. */
  authorizedActors: string[]
  pollIntervalMs: number
  /** Isolated checkout seed (`git clone --no-hardlinks`). */
  sourceRepo?: string
  /**
   * Optional verified mention handles (without @). Owner-gh: match `gh api user`.
   * GitHub App: only GET /app `slug` and `{slug}[bot]` (no arbitrary slugs).
   */
  mentionHandles?: string[]
  /** Host-only auth; default owner `gh` when omitted. */
  auth?: GithubDispatchAuthConfig
  /**
   * `claude` enables the host-side Claude Code github_fix implementer.
   * Omitted or `none` keeps fail-closed publish.
   */
  implementer?: 'claude' | 'none'
}

export interface RsiConfig {
  enabled: boolean
  intervalMs: number
  fetchAllowlist: string[]
  /** Explicit structured source URLs (HTTPS allowlisted or file:// under repo). */
  sourceUrls: string[]
  /** Product label whose meaning is unknown — recorded as unknown, not invented. */
  manusCueLabel: 'unknown'
}

export interface DispatchOwnerConfig {
  github: GithubDispatchConfig
  rsi: RsiConfig
  /** Set when `github.auth.mode` is `github-app` after fail-closed verify. */
  githubAuthHost?: DispatchHostGithubAuth
}

export const DEFAULT_AUTHORIZED_ACTORS = ['LofiSu'] as const

export const DEFAULT_POLL_INTERVAL_MS = 60_000
export const MIN_POLL_INTERVAL_MS = 15_000
export const DEFAULT_RSI_INTERVAL_MS = 6 * 60 * 60 * 1000
export const MIN_RSI_INTERVAL_MS = 30 * 60 * 1000

export const DEFAULT_RSI_SOURCE_URLS = [
  'https://docs.github.com/en',
] as const

const DEFAULT_FETCH_ALLOWLIST = [
  'instinct.com',
  'www.instinct.com',
  'docs.github.com',
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
] as const

export function dispatchConfigPath(home: string): string {
  return path.join(home, GITHUB_DISPATCH_FILE)
}

function normalizeActors(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) return [...DEFAULT_AUTHORIZED_ACTORS]
  const out = raw
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map(v => v.trim())
  if (out.length === 0) throw new UserError('github-dispatch: authorizedActors must not be empty when set')
  return out
}

function normalizeAllowlist(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) return [...DEFAULT_FETCH_ALLOWLIST]
  return raw
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map(v => v.trim().toLowerCase())
}

function normalizeSourceUrls(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) return [...DEFAULT_RSI_SOURCE_URLS]
  const out = raw
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map(v => v.trim())
  return out.length > 0 ? out : [...DEFAULT_RSI_SOURCE_URLS]
}

async function authenticatedGhLogin(gh: GhRun): Promise<string> {
  const out = await gh([
    'api', 'user',
    '--header', 'Accept: application/vnd.github+json',
    '--jq', '.login',
  ])
  const login = out.trim()
  if (!login) throw new UserError('github-dispatch: gh api user returned no login')
  return login
}

function verifiedAppMentionSet(expectedSlug: string): Set<string> {
  const slug = expectedSlug.trim()
  return new Set([slug, `${slug}[bot]`].map(s => s.toLowerCase()))
}

function assertMentionHandlesForAuth(
  mentionHandles: string[],
  auth: GithubDispatchAuthConfig,
): void {
  for (const handle of mentionHandles) {
    if (handle.toLowerCase() === UNOWNED_PUBLIC_HANDLE) {
      throw new UserError(
        `github-dispatch: mention handle "${handle}" is an unrelated public account`,
      )
    }
  }
  if (auth.mode === 'github-app' && auth.githubApp) {
    const allowed = verifiedAppMentionSet(auth.githubApp.expectedSlug)
    for (const handle of mentionHandles) {
      if (!allowed.has(handle.toLowerCase())) {
        throw new UserError(
          `github-dispatch: mention handle "${handle}" is not the verified App slug`,
        )
      }
    }
    return
  }
}

/**
 * Load owner config from outside writableRoots. Invalid or unverifiable config
 * fails closed. Tooling cannot override repo or actors from issue text.
 */
export async function loadDispatchOwnerConfig(
  home: string,
  opts: {
    gh?: GhRun
    verifyMentions?: boolean
    /** Pre-bootstrapped App auth; when omitted and mode is github-app, bootstrap runs here. */
    githubAuthHost?: DispatchHostGithubAuth
    cwd?: string
  } = {},
): Promise<DispatchOwnerConfig | undefined> {
  const file = dispatchConfigPath(home)
  if (!fs.existsSync(file)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  } catch {
    throw new UserError(`github-dispatch: ${file} is not valid JSON`)
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new UserError(`github-dispatch: ${file} must be a JSON object`)
  }
  const root = parsed as Record<string, unknown>
  const ghBlock = (root.github ?? root) as Record<string, unknown>
  const rsiBlock = (root.rsi ?? {}) as Record<string, unknown>

  const enabled = ghBlock.enabled === true || root.enabled === true
  const rsiEnabled = rsiBlock.enabled === true || root.rsiEnabled === true
  if (!enabled && !rsiEnabled) return undefined

  const repoRaw = typeof ghBlock.repo === 'string' && ghBlock.repo.trim()
    ? ghBlock.repo.trim()
    : DEFAULT_GITHUB_REPO
  let repoFull: string
  try {
    repoFull = parseRepo(repoRaw).full
  } catch (error) {
    throw new UserError(`github-dispatch: invalid repo: ${error instanceof Error ? error.message : String(error)}`)
  }

  const authorizedActors = normalizeActors(ghBlock.authorizedActors ?? root.authorizedActors)
  const pollIntervalMs = Math.max(
    MIN_POLL_INTERVAL_MS,
    Number(ghBlock.pollIntervalMs ?? root.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS,
  )

  const sourceRepo = typeof ghBlock.sourceRepo === 'string' && ghBlock.sourceRepo.trim()
    ? ghBlock.sourceRepo.trim()
    : typeof root.sourceRepo === 'string' && root.sourceRepo.trim()
      ? root.sourceRepo.trim()
      : undefined

  const implementerRaw = ghBlock.implementer ?? root.implementer
  let implementer: 'claude' | 'none' | undefined
  if (implementerRaw !== undefined && implementerRaw !== null && implementerRaw !== '') {
    const v = String(implementerRaw).trim().toLowerCase()
    if (v === 'claude') implementer = 'claude'
    else if (v === 'none') implementer = 'none'
    else throw new UserError(`github-dispatch: github.implementer must be "claude" or "none"`)
  }

  const cwd = opts.cwd ?? process.cwd()
  let githubAuthHost = opts.githubAuthHost
  if (!githubAuthHost) {
    const parsedAuth = parseGithubAuthBlock(ghBlock.auth, cwd)
    if (parsedAuth.mode === 'github-app') {
      githubAuthHost = await bootstrapDispatchGithubAuth(ghBlock.auth, repoFull, cwd)
    } else {
      githubAuthHost = { auth: parsedAuth }
    }
  }
  const dispatchAuth = githubAuthHost.auth

  let mentionHandles: string[] | undefined
  const mentionRaw = ghBlock.mentionHandles ?? root.mentionHandles
  if (mentionRaw !== undefined) {
    if (!Array.isArray(mentionRaw)) throw new UserError('github-dispatch: mentionHandles must be an array')
    mentionHandles = mentionRaw
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map(v => v.trim().replace(/^@/, ''))
    assertMentionHandlesForAuth(mentionHandles, dispatchAuth)
    if (opts.verifyMentions !== false && mentionHandles.length > 0 && dispatchAuth.mode !== 'github-app') {
      const gh = opts.gh ?? runGh
      const login = (await authenticatedGhLogin(gh)).toLowerCase()
      for (const handle of mentionHandles) {
        if (handle.toLowerCase() !== login) {
          throw new UserError(
            `github-dispatch: mention handle "${handle}" does not match authenticated gh login "${login}"`,
          )
        }
      }
    }
  }

  const rsiIntervalMs = Math.max(
    MIN_RSI_INTERVAL_MS,
    Number(rsiBlock.intervalMs ?? root.rsiIntervalMs) || DEFAULT_RSI_INTERVAL_MS,
  )

  return {
    github: {
      enabled,
      repo: repoFull,
      authorizedActors,
      pollIntervalMs,
      ...(sourceRepo ? { sourceRepo } : {}),
      ...(mentionHandles?.length ? { mentionHandles } : {}),
      ...(implementer ? { implementer } : {}),
      auth: dispatchAuth,
    },
    ...(githubAuthHost.auth.mode === 'github-app' ? { githubAuthHost } : {}),
    rsi: {
      enabled: rsiEnabled,
      intervalMs: rsiIntervalMs,
      fetchAllowlist: normalizeAllowlist(rsiBlock.fetchAllowlist ?? root.fetchAllowlist),
      sourceUrls: normalizeSourceUrls(rsiBlock.sourceUrls ?? root.rsiSourceUrls),
      manusCueLabel: 'unknown',
    },
  }
}

/** Parse config without network verification (unit tests). */
export function loadDispatchOwnerConfigSync(home: string): DispatchOwnerConfig | undefined {
  const file = dispatchConfigPath(home)
  if (!fs.existsSync(file)) return undefined
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  const ghBlock = (parsed.github ?? parsed) as Record<string, unknown>
  const rsiBlock = (parsed.rsi ?? {}) as Record<string, unknown>
  const enabled = ghBlock.enabled === true || parsed.enabled === true
  const rsiEnabled = rsiBlock.enabled === true || parsed.rsiEnabled === true
  if (!enabled && !rsiEnabled) return undefined
  const repoFull = parseRepo(
    typeof ghBlock.repo === 'string' ? ghBlock.repo : DEFAULT_GITHUB_REPO,
  ).full
  const dispatchAuth = parseGithubAuthBlock(ghBlock.auth, process.cwd())
  let mentionHandles: string[] | undefined
  const mentionRaw = ghBlock.mentionHandles as unknown
  if (Array.isArray(mentionRaw)) {
    mentionHandles = mentionRaw
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map(v => v.trim().replace(/^@/, ''))
    assertMentionHandlesForAuth(mentionHandles, dispatchAuth)
  }
  let syncImplementer: 'claude' | 'none' | undefined
  const implementerRaw = ghBlock.implementer ?? parsed.implementer
  if (implementerRaw !== undefined && implementerRaw !== null && implementerRaw !== '') {
    const v = String(implementerRaw).trim().toLowerCase()
    if (v === 'claude') syncImplementer = 'claude'
    else if (v === 'none') syncImplementer = 'none'
    else throw new UserError(`github-dispatch: github.implementer must be "claude" or "none"`)
  }
  return {
    github: {
      enabled,
      repo: repoFull,
      authorizedActors: normalizeActors(ghBlock.authorizedActors),
      pollIntervalMs: Math.max(MIN_POLL_INTERVAL_MS, Number(ghBlock.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS),
      ...(typeof ghBlock.sourceRepo === 'string' ? { sourceRepo: ghBlock.sourceRepo } : {}),
      ...(mentionHandles?.length ? { mentionHandles } : {}),
      ...(syncImplementer ? { implementer: syncImplementer } : {}),
      auth: dispatchAuth,
    },
    rsi: {
      enabled: rsiEnabled,
      intervalMs: Math.max(MIN_RSI_INTERVAL_MS, Number(rsiBlock.intervalMs) || DEFAULT_RSI_INTERVAL_MS),
      fetchAllowlist: normalizeAllowlist(rsiBlock.fetchAllowlist),
      sourceUrls: normalizeSourceUrls(rsiBlock.sourceUrls),
      manusCueLabel: 'unknown',
    },
  }
}

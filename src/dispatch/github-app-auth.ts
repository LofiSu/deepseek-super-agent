import { createSign } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { GithubRepoRef } from '../channels/github-source.ts'
import { parseRepo, type GhRun } from '../channels/github-source.ts'
import type { GitRun } from '../env/git-publish.ts'
import { UserError } from '../shared/errors.ts'

const GITHUB_API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000

export interface GithubAppAuthConfig {
  mode: 'github-app'
  appId: string
  clientId: string
  installationId: string
  privateKeyFile: string
  expectedSlug: string
}

export interface GithubDispatchAuthConfig {
  mode: 'owner-gh' | 'github-app'
  githubApp?: GithubAppAuthConfig
}

/** Redact secrets from error messages (never log PEM, JWT, installation tokens). */
export function redactGithubAuthSecret(text: string): string {
  let out = text
  out = out.replace(/ghs_[A-Za-z0-9_]+/gi, 'ghs_[REDACTED]')
  out = out.replace(/Bearer\s+[^\s"]+/gi, 'Bearer [REDACTED]')
  out = out.replace(/BEGIN [A-Z ]+PRIVATE KEY[\s\S]*?END [A-Z ]+PRIVATE KEY/g, '[PEM REDACTED]')
  out = out.replace(/x-access-token:[^@\s]+/gi, 'x-access-token:[REDACTED]')
  return out
}

function safeUserError(message: string): UserError {
  return new UserError(redactGithubAuthSecret(message))
}

function coerceGithubAuthId(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim()
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(Math.trunc(raw))
  return ''
}

function assertPrivateKeyFile(file: string, cwd: string): string {
  if (!file.trim()) throw safeUserError('github.auth: privateKeyFile is required')
  const resolved = path.resolve(file.trim())
  if (!path.isAbsolute(resolved)) {
    throw safeUserError('github.auth: privateKeyFile must be an absolute path')
  }
  if (!fs.existsSync(resolved)) {
    throw safeUserError('github.auth: privateKeyFile does not exist')
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch {
    throw safeUserError('github.auth: privateKeyFile is not readable')
  }
  if (!stat.isFile()) throw safeUserError('github.auth: privateKeyFile must be a regular file')
  const mode = stat.mode & 0o777
  if (mode !== 0o600 && mode !== 0o400) {
    throw safeUserError('github.auth: privateKeyFile must be mode 0600 or 0400')
  }
  const repoRoot = path.resolve(cwd)
  if (resolved === repoRoot || resolved.startsWith(`${repoRoot}${path.sep}`)) {
    throw safeUserError('github.auth: privateKeyFile must be outside the repository')
  }
  const workspacesRoot = path.resolve('/workspace')
  if (resolved.startsWith(`${workspacesRoot}${path.sep}`) || resolved === workspacesRoot) {
    throw safeUserError('github.auth: privateKeyFile must be outside workspace roots')
  }
  return resolved
}

function readPrivateKeyPem(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    throw safeUserError('github.auth: could not read privateKeyFile')
  }
}

/** RS256 JWT for GitHub App (iat up to 60s past, exp ≤ 10 min; iss = Client ID recommended). */
export function signGithubAppJwt(clientId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iat: nowSec - 30,
    exp: nowSec + 9 * 60,
    iss: clientId.trim(),
  }
  const enc = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  const signingInput = `${enc(header)}.${enc(payload)}`
  const sign = createSign('RSA-SHA256')
  sign.update(signingInput)
  sign.end()
  const sig = sign.sign(privateKeyPem)
  return `${signingInput}.${sig.toString('base64url')}`
}

interface FetchJsonOpts {
  method?: string
  body?: unknown
  bearer: string
}

async function fetchGithubJson<T>(urlPath: string, opts: FetchJsonOpts): Promise<T> {
  const url = urlPath.startsWith('https://') ? urlPath : `${GITHUB_API}/${urlPath.replace(/^\//, '')}`
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    Authorization: `Bearer ${opts.bearer}`,
    'User-Agent': 'ds-agent-github-app-auth',
  }
  let body: string | undefined
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  const res = await fetch(url, { method: opts.method ?? 'GET', headers, body })
  const text = await res.text()
  if (!res.ok) {
    throw safeUserError(redactGithubAuthSecret(`GitHub API ${res.status}: ${text.slice(0, 200)}`))
  }
  if (!text.trim()) return undefined as T
  return JSON.parse(text) as T
}

export type GithubHttpFetch = typeof fetchGithubJson

interface CachedToken {
  token: string
  expiresAtMs: number
}

export class GithubAppAuthService {
  private readonly config: GithubAppAuthConfig
  private readonly pem: string
  private readonly repo: GithubRepoRef
  private readonly fetchJson: GithubHttpFetch
  private cached?: CachedToken
  private verified = false
  private readonly verifiedMentionHandles: string[]

  constructor(
    config: GithubAppAuthConfig,
    repoFull: string,
    fetchJson: GithubHttpFetch = fetchGithubJson,
  ) {
    this.config = config
    this.pem = readPrivateKeyPem(config.privateKeyFile)
    this.repo = parseRepo(repoFull)
    this.fetchJson = fetchJson
    const slug = config.expectedSlug.trim()
    this.verifiedMentionHandles = [slug, `${slug}[bot]`]
  }

  /** Handles verified via GET /app slug only (no gh api user). */
  mentionHandlesForConfig(): string[] {
    return [...this.verifiedMentionHandles]
  }

  async verifyFailClosed(): Promise<void> {
    if (this.verified) return
    const jwt = signGithubAppJwt(this.config.clientId, this.pem)
    const app = await this.fetchJson<{ id?: number; slug?: string }>('app', { bearer: jwt })
    const appId = String(app.id ?? '')
    if (appId !== this.config.appId.trim()) {
      throw safeUserError('github.auth: GET /app id does not match configured appId')
    }
    const slug = (app.slug ?? '').trim()
    if (slug !== this.config.expectedSlug.trim()) {
      throw safeUserError('github.auth: GET /app slug does not match expectedSlug')
    }
    const instPath = `repos/${this.repo.full}/installation`
    const inst = await this.fetchJson<{ id?: number }>(instPath, { bearer: jwt })
    if (String(inst.id ?? '') !== this.config.installationId.trim()) {
      throw safeUserError('github.auth: repo installation id does not match installationId')
    }
    this.verified = true
  }

  private async mintInstallationToken(): Promise<CachedToken> {
    await this.verifyFailClosed()
    const jwt = signGithubAppJwt(this.config.clientId, this.pem)
    const out = await this.fetchJson<{
      token: string
      expires_at: string
    }>(`app/installations/${this.config.installationId}/access_tokens`, {
      method: 'POST',
      bearer: jwt,
      body: {
        repositories: [this.repo.repo],
        permissions: {
          contents: 'write',
          pull_requests: 'write',
          issues: 'read',
          metadata: 'read',
        },
      },
    })
    const token = out.token?.trim()
    if (!token) throw safeUserError('github.auth: installation token response missing token')
    const expiresAtMs = Date.parse(out.expires_at)
    if (!Number.isFinite(expiresAtMs)) {
      throw safeUserError('github.auth: installation token response missing expires_at')
    }
    return { token, expiresAtMs }
  }

  async getInstallationToken(): Promise<string> {
    const now = Date.now()
    if (this.cached && this.cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > now) {
      return this.cached.token
    }
    this.cached = await this.mintInstallationToken()
    return this.cached.token
  }

  /** Mint token on each invocation; fresh 0700 GH_CONFIG_DIR per gh child; GH_TOKEN in env only. */
  createGhRun(): GhRun {
    const service = this
    return (args, input) => new Promise((resolve, reject) => {
      void (async () => {
        const token = await service.getInstallationToken()
        const ghConfigDir = mkdtempSync(path.join(os.tmpdir(), 'ds-gh-app-config-'))
        mkdirSync(ghConfigDir, { recursive: true, mode: 0o700 })
        writeFileSync(
          path.join(ghConfigDir, 'hosts.yml'),
          'github.com:\n    user: git\n    oauth_token: placeholder\n',
          { mode: 0o600 },
        )
        const childEnv = {
          ...process.env,
          GH_TOKEN: token,
          GH_CONFIG_DIR: ghConfigDir,
        }
        const child = spawn('gh', args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: childEnv,
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk: Buffer | string) => { stdout += String(chunk) })
        child.stderr.on('data', (chunk: Buffer | string) => { stderr += String(chunk) })
        child.on('error', error => {
          try { rmSync(ghConfigDir, { recursive: true, force: true }) } catch { /* best-effort */ }
          reject(safeUserError(`cannot run gh: ${error.message}`))
        })
        child.on('close', code => {
          try { rmSync(ghConfigDir, { recursive: true, force: true }) } catch { /* best-effort */ }
          if (code === 0) {
            resolve(stdout)
            return
          }
          reject(safeUserError(`gh failed (exit ${code}): ${(stderr || stdout).trim().slice(0, 400)}`))
        })
        child.stdin.end(input ?? '')
      })().catch(reject)
    })
  }

  /** Token fetched per git invocation; Bearer in child env only. */
  createAuthenticatedGitRun(): GitRun {
    const service = this
    return (args, opts) => new Promise((resolve, reject) => {
      void (async () => {
        const token = await service.getInstallationToken()
        const env = {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
          GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
        }
        const child = spawn('git', args, {
          cwd: opts.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...env },
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk: Buffer | string) => { stdout += String(chunk) })
        child.stderr.on('data', (chunk: Buffer | string) => { stderr += String(chunk) })
        child.on('error', error => reject(new Error(redactGithubAuthSecret(`cannot run git: ${error.message}`))))
        child.on('close', code => resolve({
          code: code ?? 1,
          stdout,
          stderr: redactGithubAuthSecret(stderr),
        }))
      })().catch(reject)
    })
  }
}

export function parseGithubAuthBlock(
  raw: unknown,
  cwd: string,
): GithubDispatchAuthConfig {
  if (raw === undefined || raw === null) {
    return { mode: 'owner-gh' }
  }
  if (typeof raw !== 'object') {
    throw safeUserError('github.auth must be a JSON object')
  }
  const block = raw as Record<string, unknown>
  const mode = String(block.mode ?? '').trim().toLowerCase()
  if (!mode || mode === 'owner-gh' || mode === 'owner') {
    return { mode: 'owner-gh' }
  }
  if (mode !== 'github-app') {
    throw safeUserError('github.auth.mode must be "github-app" or omitted (owner gh)')
  }
  const appId = coerceGithubAuthId(block.appId)
  const clientId = typeof block.clientId === 'string' ? block.clientId.trim() : ''
  const installationId = coerceGithubAuthId(block.installationId)
  const expectedSlug = typeof block.expectedSlug === 'string' ? block.expectedSlug.trim() : ''
  const privateKeyFile = assertPrivateKeyFile(
    typeof block.privateKeyFile === 'string' ? block.privateKeyFile : '',
    cwd,
  )
  if (!appId || !clientId || !installationId || !expectedSlug) {
    throw safeUserError('github.auth: appId, clientId, installationId, and expectedSlug are required for github-app mode')
  }
  return {
    mode: 'github-app',
    githubApp: {
      mode: 'github-app',
      appId,
      clientId,
      installationId,
      privateKeyFile,
      expectedSlug,
    },
  }
}

export interface DispatchHostGithubAuth {
  readonly auth: GithubDispatchAuthConfig
  readonly app?: GithubAppAuthService
}

/**
 * Parse auth block, verify App when github-app, register shared service.
 * Invalid github-app config throws — no fallback to owner gh.
 */
export async function bootstrapDispatchGithubAuth(
  authRaw: unknown,
  repoFull: string,
  cwd: string,
  fetchJson: GithubHttpFetch = fetchGithubJson,
): Promise<DispatchHostGithubAuth> {
  const auth = parseGithubAuthBlock(authRaw, cwd)
  if (auth.mode !== 'github-app' || !auth.githubApp) {
    return { auth }
  }
  const app = new GithubAppAuthService(auth.githubApp, repoFull, fetchJson)
  await app.verifyFailClosed()
  return { auth, app }
}

/** Owner `runGh` only when auth is owner-gh; github-app mode never falls back to owner gh. */
export async function ghRunForDispatchHost(host: DispatchHostGithubAuth): Promise<GhRun> {
  if (host.auth.mode === 'github-app') {
    if (!host.app) {
      throw safeUserError('github.auth: github-app mode requires a verified App auth service')
    }
    return host.app.createGhRun()
  }
  const { runGh } = await import('../channels/github-source.ts')
  return runGh
}

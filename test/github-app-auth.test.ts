import { generateKeyPairSync } from 'node:crypto'
import fs, { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  UNOWNED_PUBLIC_HANDLE,
  loadDispatchOwnerConfigSync,
} from '../src/dispatch/config.ts'
import {
  GithubAppAuthService,
  bootstrapDispatchGithubAuth,
  ghRunForDispatchHost,
  parseGithubAuthBlock,
  redactGithubAuthSecret,
  signGithubAppJwt,
  type GithubHttpFetch,
} from '../src/dispatch/github-app-auth.ts'
import { UserError } from '../src/shared/errors.ts'
import { tempHome } from './fixtures.ts'

const REPO = 'LofiSu/deepseek-super-agent'
const CLIENT_ID = 'Iv1.testclient'
const APP_ID = '5772121'
const INSTALL_ID = '182274751'
const SLUG = 'lofisu-peanut-agent'

/** PEM outside any tempHome cwd (repo / workspace policy). */
function fixturePem(mode: 0o600 | 0o644 = 0o600): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ds-agent-app-pem-'))
  const file = path.join(dir, 'app.pem')
  writeFileSync(file, pem, { mode: 0o600 })
  try {
    chmodSync(file, mode)
  } catch {
    // some FS ignore chmod in tests
  }
  return file
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.')
  expect(parts.length).toBe(3)
  return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
}

function mockGithubFetch(opts: {
  appId?: string
  slug?: string
  installationId?: string
  token?: string
  expiresAt?: string
  failWithToken?: string
}): GithubHttpFetch {
  const token = opts.token ?? 'ghs_testfixturetoken000000000'
  const expiresAt = opts.expiresAt ?? new Date(Date.now() + 55 * 60 * 1000).toISOString()
  return vi.fn(async (urlPath: string, req) => {
    if (opts.failWithToken && urlPath === 'app') {
      throw new UserError(redactGithubAuthSecret(`GitHub API 401: ${opts.failWithToken}`))
    }
    if (urlPath === 'app') {
      return { id: Number(opts.appId ?? APP_ID), slug: opts.slug ?? SLUG }
    }
    if (urlPath.includes('/access_tokens')) {
      return { token, expires_at: expiresAt }
    }
    if (urlPath.includes('/installation')) {
      return { id: Number(opts.installationId ?? INSTALL_ID) }
    }
    void req
    throw new Error(`unexpected fetch ${urlPath}`)
  }) as GithubHttpFetch
}

function authBlock(extra: Record<string, unknown> = {}, pemFile: string) {
  return {
    mode: 'github-app',
    appId: APP_ID,
    clientId: CLIENT_ID,
    installationId: INSTALL_ID,
    privateKeyFile: pemFile,
    expectedSlug: SLUG,
    ...extra,
  }
}

describe('signGithubAppJwt', () => {
  it('uses RS256, iss=clientId, iat in past, exp within 10 minutes', () => {
    const pemFile = fixturePem()
    const pem = fs.readFileSync(pemFile, 'utf8')
    const now = 1_700_000_000
    const jwt = signGithubAppJwt(CLIENT_ID, pem, now)
    const header = JSON.parse(Buffer.from(jwt.split('.')[0]!, 'base64url').toString())
    expect(header.alg).toBe('RS256')
    const payload = decodeJwtPayload(jwt)
    expect(payload.iss).toBe(CLIENT_ID)
    expect(payload.iat).toBeLessThanOrEqual(now)
    expect(now - Number(payload.iat)).toBeLessThanOrEqual(60)
    expect(Number(payload.exp)).toBeLessThanOrEqual(now + 10 * 60)
    expect(Number(payload.exp)).toBeGreaterThan(now)
  })
})

describe('parseGithubAuthBlock', () => {
  it('coerces numeric appId and installationId', () => {
    const pem = fixturePem()
    const parsed = parseGithubAuthBlock(authBlock({ appId: 5772121, installationId: 182274751 }, pem), process.cwd())
    expect(parsed.mode).toBe('github-app')
    expect(parsed.githubApp?.appId).toBe('5772121')
    expect(parsed.githubApp?.installationId).toBe('182274751')
  })

  it('refuses world-readable PEM', () => {
    const pem = fixturePem(0o644)
    expect(() => parseGithubAuthBlock(authBlock({}, pem), process.cwd())).toThrow(/0600|0400/)
  })

  it('refuses PEM inside repo cwd', () => {
    const cwd = tempHome()
    const pem = path.join(cwd, 'leak.pem')
    writeFileSync(pem, 'x', { mode: 0o600 })
    expect(() => parseGithubAuthBlock(authBlock({}, pem), cwd)).toThrow(/outside the repository/)
  })

  it('refuses missing github-app fields', () => {
    const pem = fixturePem()
    expect(() => parseGithubAuthBlock({ mode: 'github-app', privateKeyFile: pem }, process.cwd())).toThrow(/required/)
  })
})

describe('GithubAppAuthService verification', () => {
  it('refuses app id, installation, and slug mismatches', async () => {
    const pem = fixturePem()
    const cfg = parseGithubAuthBlock(authBlock({}, pem), process.cwd()).githubApp!
    const badApp = new GithubAppAuthService(cfg, REPO, mockGithubFetch({ appId: '1' }))
    await expect(badApp.verifyFailClosed()).rejects.toThrow(/appId/)
    const badSlug = new GithubAppAuthService(cfg, REPO, mockGithubFetch({ slug: 'other-slug' }))
    await expect(badSlug.verifyFailClosed()).rejects.toThrow(/expectedSlug/)
    const badInst = new GithubAppAuthService(cfg, REPO, mockGithubFetch({ installationId: '9' }))
    await expect(badInst.verifyFailClosed()).rejects.toThrow(/installationId/)
  })

  it('caches installation token and refreshes after expiry skew', async () => {
    const pem = fixturePem()
    const cfg = parseGithubAuthBlock(authBlock({}, pem), process.cwd()).githubApp!
    let mints = 0
    const fetchJson = vi.fn(async (urlPath: string) => {
      if (urlPath === 'app') return { id: Number(APP_ID), slug: SLUG }
      if (urlPath.includes('/access_tokens')) {
        mints += 1
        const ttlMs = mints === 1 ? 55 * 60 * 1000 : 55 * 60 * 1000
        const soon = new Date(Date.now() + ttlMs).toISOString()
        return { token: `ghs_round${mints}`, expires_at: soon }
      }
      if (urlPath.includes('/installation')) return { id: Number(INSTALL_ID) }
      throw new Error(urlPath)
    }) as GithubHttpFetch
    const svc = new GithubAppAuthService(cfg, REPO, fetchJson)
    vi.useFakeTimers()
    const base = new Date('2026-06-01T12:00:00.000Z')
    vi.setSystemTime(base)
    try {
      const t1 = await svc.getInstallationToken()
      const t2 = await svc.getInstallationToken()
      expect(t1).toBe(t2)
      expect(mints).toBe(1)
      vi.setSystemTime(new Date(base.getTime() + 56 * 60 * 1000))
      const t3 = await svc.getInstallationToken()
      expect(t3).not.toBe(t1)
      expect(mints).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ghRunForDispatchHost', () => {
  it('does not fall back to owner gh when github-app mode lacks app service', async () => {
    await expect(ghRunForDispatchHost({ auth: { mode: 'github-app' } })).rejects.toThrow(/verified App auth/)
  })
})

describe('mentionHandles in github-app mode', () => {
  it('accepts verified slug and [bot] only via sync load', () => {
    const home = tempHome()
    const pem = fixturePem()
    fs.writeFileSync(path.join(home, 'github-dispatch.json'), JSON.stringify({
      github: {
        enabled: true,
        repo: REPO,
        mentionHandles: [SLUG, `${SLUG}[bot]`],
        auth: authBlock({}, pem),
      },
    }))
    const cfg = loadDispatchOwnerConfigSync(home)!
    expect(cfg.github.mentionHandles).toEqual([SLUG, `${SLUG}[bot]`])
    expect(() => loadDispatchOwnerConfigSync(home)).not.toThrow()
  })

  it('refuses arbitrary slug and ds-agent', () => {
    const home = tempHome()
    const pem = fixturePem()
    const write = (handles: string[]) => {
      fs.writeFileSync(path.join(home, 'github-dispatch.json'), JSON.stringify({
        github: { enabled: true, repo: REPO, mentionHandles: handles, auth: authBlock({}, pem) },
      }))
    }
    write(['evil-bot'])
    expect(() => loadDispatchOwnerConfigSync(home)).toThrow(/verified App slug/)
    write([UNOWNED_PUBLIC_HANDLE])
    expect(() => loadDispatchOwnerConfigSync(home)).toThrow(/unrelated public account/)
  })

  it('mentionHandlesForConfig does not require gh api user', () => {
    const pem = fixturePem()
    const cfg = parseGithubAuthBlock(authBlock({}, pem), process.cwd()).githubApp!
    const svc = new GithubAppAuthService(cfg, REPO, mockGithubFetch({}))
    expect(svc.mentionHandlesForConfig()).toEqual([SLUG, `${SLUG}[bot]`])
  })
})

describe('redactGithubAuthSecret', () => {
  it('strips tokens and PEM material from errors', () => {
    const fake = 'ghs_leakedtok_AAAA and Bearer ghs_xxx and BEGIN RSA PRIVATE KEY\nMII\nEND RSA PRIVATE KEY'
    const out = redactGithubAuthSecret(fake)
    expect(out).not.toMatch(/ghs_leakedtok/)
    expect(out).not.toMatch(/BEGIN RSA/)
    expect(out).toContain('[REDACTED]')
  })

  it('redacts through bootstrap failure path', async () => {
    const pem = fixturePem()
    const failWith = 'ghs_supersecret_in_error_body'
    try {
      await bootstrapDispatchGithubAuth(
        authBlock({}, pem),
        REPO,
        process.cwd(),
        mockGithubFetch({ failWithToken: failWith }),
      )
      expect.fail('expected bootstrap to throw')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      expect(msg).not.toContain('ghs_supersecret')
      expect(msg).toMatch(/401|GitHub API/)
    }
  })
})

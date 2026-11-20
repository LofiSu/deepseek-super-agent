import type { GoogleCredentials } from './config.ts'

/**
 * Google OAuth refresh-token exchange.
 *
 * Only the public token endpoint is used. A refresh token is exchanged for a
 * short-lived access token; the token is cached until shortly before expiry.
 * Neither the refresh token nor the access token is logged or persisted by
 * this module.
 */

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const DEFAULT_EXPIRES_SECONDS = 3_600
const EXPIRY_SKEW_MS = 60_000

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface GoogleTokenProvider {
  accessToken(signal?: AbortSignal): Promise<string>
  /** Drop a cached token, for example after a 401 from an API call. */
  invalidate(): void
}

export interface RefreshTokenProviderOptions {
  fetch?: FetchLike
  now?: () => number
  tokenUrl?: string
}

export class RefreshTokenProvider implements GoogleTokenProvider {
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly tokenUrl: string
  private cached?: { token: string; expiresAt: number }

  constructor(
    private readonly credentials: GoogleCredentials,
    options: RefreshTokenProviderOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.tokenUrl = options.tokenUrl ?? GOOGLE_TOKEN_URL
  }

  async accessToken(signal?: AbortSignal): Promise<string> {
    const cached = this.cached
    if (cached && this.now() < cached.expiresAt - EXPIRY_SKEW_MS) return cached.token
    return this.refresh(signal)
  }

  invalidate(): void {
    this.cached = undefined
  }

  private async refresh(signal?: AbortSignal): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      refresh_token: this.credentials.refreshToken,
      grant_type: 'refresh_token',
    })
    const response = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) {
      // Google's error body may carry error/error_description only. Read a
      // bounded reason for the operator, never echo the request body.
      const reason = await safeErrorReason(response)
      throw new Error(`google oauth refresh failed status=${response.status}${reason ? ` reason=${reason}` : ''}`)
    }
    const payload = await response.json() as { access_token?: unknown; expires_in?: unknown }
    if (typeof payload.access_token !== 'string' || !payload.access_token) {
      throw new Error('google oauth refresh failed: response has no access_token')
    }
    const expiresIn = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) && payload.expires_in > 0
      ? payload.expires_in
      : DEFAULT_EXPIRES_SECONDS
    this.cached = { token: payload.access_token, expiresAt: this.now() + expiresIn * 1_000 }
    return payload.access_token
  }
}

async function safeErrorReason(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { error?: unknown; error_description?: unknown }
    const raw = typeof payload.error === 'string' ? payload.error : payload.error_description
    if (typeof raw !== 'string') return ''
    return raw.replace(/[^\w .-]/g, '').slice(0, 80)
  } catch {
    return ''
  }
}

import { describe, expect, it } from 'vitest'
import { GoogleInvalidPageTokenError, HttpGoogleWorkspaceApi, type GoogleFetchQuery } from '../src/connectors/google.ts'
import { RefreshTokenProvider, type FetchLike, type GoogleTokenProvider } from '../src/connectors/oauth.ts'
import type { GoogleCredentials } from '../src/connectors/config.ts'

const T0 = Date.parse('2026-11-05T10:00:00.000Z')
const credentials: GoogleCredentials = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  refreshToken: 'refresh-token',
}

function query(overrides: Partial<GoogleFetchQuery> = {}): GoogleFetchQuery {
  return {
    since: new Date(T0 - 60 * 60_000).toISOString(),
    until: new Date(T0).toISOString(),
    limit: 10,
    lookaheadMinutes: 120,
    ...overrides,
  }
}

const fixedToken: GoogleTokenProvider = {
  accessToken: async () => 'access-token',
  invalidate: () => undefined,
}

describe('Google OAuth token provider', () => {
  it('includes token resolution within the API request deadline', async () => {
    let tokenSignal: AbortSignal | undefined
    const tokenProvider: GoogleTokenProvider = {
      accessToken: signal => {
        tokenSignal = signal
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
      invalidate: () => undefined,
    }
    const api = new HttpGoogleWorkspaceApi(tokenProvider, {
      fetch: async () => { throw new Error('API fetch must not run before token acquisition') },
      apiBase: 'https://example.test',
      requestTimeoutMs: 5,
    })
    await expect(api.fetch('gmail', query())).rejects.toThrow()
    expect(tokenSignal?.aborted).toBe(true)
  })

  it('exchanges the refresh token once, caches the access token, and refreshes after expiry', async () => {
    let now = T0
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({ access_token: 'token-1', expires_in: 3_600 }), { status: 200 })
    }
    const provider = new RefreshTokenProvider(credentials, { fetch: fetchImpl, now: () => now })
    expect(await provider.accessToken()).toBe('token-1')
    expect(await provider.accessToken()).toBe('token-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('oauth2.googleapis.com/token')
    const body = String(calls[0]?.init?.body)
    expect(body).toContain('grant_type=refresh_token')
    expect(body).toContain('client_id=client-id')

    now += 3_600_000
    expect(await provider.accessToken()).toBe('token-1')
    expect(calls).toHaveLength(2)
  })

  it('reports a bounded error reason without leaking credentials', async () => {
    const fetchImpl: FetchLike = async () => new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
      { status: 400 },
    )
    const provider = new RefreshTokenProvider(credentials, { fetch: fetchImpl, now: () => T0 })
    await expect(provider.accessToken()).rejects.toThrow(/status=400 reason=invalid_grant/)
    const message = await provider.accessToken().catch(error => String(error))
    expect(message).not.toContain('refresh-token')
    expect(message).not.toContain('client-secret')
  })

  it('fails closed when the token response has no access token', async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ expires_in: 3_600 }), { status: 200 })
    const provider = new RefreshTokenProvider(credentials, { fetch: fetchImpl, now: () => T0 })
    await expect(provider.accessToken()).rejects.toThrow(/no access_token/)
  })
})

describe('Google Workspace mapping', () => {
  it('sends continuation tokens for Gmail, Drive, Calendar, and Tasks pages', async () => {
    const services = ['gmail', 'drive', 'calendar', 'tasks'] as const
    for (const service of services) {
      const seen: string[] = []
      const fetchImpl: FetchLike = async input => {
        const url = new URL(String(input))
        seen.push(url.toString())
        const body = service === 'gmail' ? { messages: [] }
          : service === 'drive' ? { files: [] }
            : service === 'calendar' ? { items: [] }
              : { items: [] }
        const requestsToken = service !== 'drive'
          || url.searchParams.get('fields')?.split(',').includes('nextPageToken') === true
        return new Response(JSON.stringify({
          ...body,
          ...(requestsToken ? { nextPageToken: 'next-page' } : {}),
        }), { status: 200 })
      }
      const api = new HttpGoogleWorkspaceApi(fixedToken, {
        fetch: fetchImpl,
        now: () => T0,
        apiBase: 'https://example.test',
      })
      const first = await api.fetchPage(service, query())
      expect(first.nextPageToken).toBe('next-page')
      await api.fetchPage(service, query({ pageToken: first.nextPageToken }))
      expect(seen.map(url => new URL(url).searchParams.get('pageToken'))).toContain('next-page')
    }
  })

  it('requests Drive-family continuation fields and preserves page checkpoints', async () => {
    const services = ['drive', 'docs', 'sheets', 'slides'] as const
    const requests: URL[] = []
    const fetchImpl: FetchLike = async input => {
      const url = new URL(String(input))
      requests.push(url)
      const fields = url.searchParams.get('fields') ?? ''
      const response = {
        files: [],
        // Match Google's partial response behavior: an unrequested field is
        // absent, even when the provider has a continuation.
        ...(fields.split(',').includes('nextPageToken') ? { nextPageToken: 'drive-page-2' } : {}),
      }
      return new Response(JSON.stringify(response), { status: 200 })
    }
    const api = new HttpGoogleWorkspaceApi(fixedToken, {
      fetch: fetchImpl,
      now: () => T0,
      apiBase: 'https://example.test',
    })

    for (const service of services) {
      const page = await api.fetchPage(service, query())
      expect(requests.at(-1)?.searchParams.get('fields')).toContain('files(')
      expect(requests.at(-1)?.searchParams.get('fields')?.split(',')).toContain('nextPageToken')
      expect(page.nextPageToken).toBe('drive-page-2')
      await api.fetchPage(service, query({ pageToken: page.nextPageToken }))
      expect(requests.at(-1)?.searchParams.get('pageToken')).toBe('drive-page-2')
    }

    // The fixture itself omits the token when a request omits it, so reverting
    // DRIVE_FIELDS to files(...) alone reproduces the silent end-of-window.
    const unmasked = await fetchImpl(new URL('https://example.test/drive/v3/files?fields=files%28id%29'))
    expect(await unmasked.json()).toEqual({ files: [] })
  })

  it('replays index records displaced by urgent calendar events before advancing pages', async () => {
    const imminent = {
      id: 'imminent-event',
      summary: 'Synthetic imminent event',
      start: { dateTime: new Date(T0 + 30 * 60_000).toISOString() },
      end: { dateTime: new Date(T0 + 60 * 60_000).toISOString() },
    }
    const olderPageEvent = {
      id: 'later-page-event',
      summary: 'Synthetic later event',
      start: { dateTime: new Date(T0 + 6 * 24 * 60 * 60_000).toISOString() },
      end: { dateTime: new Date(T0 + 6 * 24 * 60 * 60_000 + 60 * 60_000).toISOString() },
    }
    let urgentCalls = 0
    const indexRequests: URL[] = []
    const fetchImpl: FetchLike = async input => {
      const url = new URL(String(input))
      if (url.searchParams.get('maxResults') === '2500') {
        urgentCalls += 1
        return new Response(JSON.stringify({ items: [imminent] }), { status: 200 })
      }
      indexRequests.push(url)
      return new Response(JSON.stringify({ items: [olderPageEvent], nextPageToken: 'later-page' }), { status: 200 })
    }
    const api = new HttpGoogleWorkspaceApi(fixedToken, {
      fetch: fetchImpl,
      now: () => T0,
      apiBase: 'https://example.test',
    })
    const page = await api.fetchPage('calendar', query({ limit: 1 }))
    expect(page.drafts).toHaveLength(1)
    expect(page.drafts[0]).toMatchObject({ externalId: 'imminent-event', wake: true })
    expect(page.nextPageToken).toBeDefined()
    expect(page.nextPageToken).not.toBe('later-page')

    const replay = await api.fetchPage('calendar', query({ limit: 1, pageToken: page.nextPageToken }))
    expect(replay.drafts).toHaveLength(1)
    expect(replay.drafts[0]).toMatchObject({ externalId: 'later-page-event', wake: false })
    expect(replay.nextPageToken).toBe('later-page')
    expect(indexRequests[0]?.searchParams.has('pageToken')).toBe(false)
    expect(indexRequests[1]?.searchParams.has('pageToken')).toBe(false)

    const laterFirstPage = await api.fetchPage('calendar', query({ limit: 1, pageToken: 'provider-page-2' }))
    const laterReplay = await api.fetchPage('calendar', query({ limit: 1, pageToken: laterFirstPage.nextPageToken }))
    expect(laterReplay.nextPageToken).toBe('later-page')
    expect(indexRequests.at(-2)?.searchParams.get('pageToken')).toBe('provider-page-2')
    expect(indexRequests.at(-1)?.searchParams.get('pageToken')).toBe('provider-page-2')
    expect(urgentCalls).toBe(2)
  })

  it('maps Gmail messages and marks unread important mail', async () => {
    const seen: string[] = []
    const fetchImpl: FetchLike = async input => {
      const url = String(input)
      seen.push(url)
      if (url.includes('/messages/m1')) {
        return new Response(JSON.stringify({
          id: 'm1',
          threadId: 't1',
          labelIds: ['UNREAD', 'IMPORTANT'],
          snippet: 'The invoice is attached',
          internalDate: String(T0),
          payload: {
            headers: [
              { name: 'Subject', value: 'Invoice for November' },
              { name: 'From', value: 'Billing <billing@example.com>' },
              { name: 'To', value: 'owner@example.com' },
            ],
          },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ messages: [{ id: 'm1' }] }), { status: 200 })
    }
    const api = new HttpGoogleWorkspaceApi(fixedToken, {
      fetch: fetchImpl,
      now: () => T0,
      apiBase: 'https://example.test',
    })
    const [record] = await api.fetch('gmail', query())
    expect(record).toMatchObject({
      service: 'gmail',
      kind: 'message',
      externalId: 'm1',
      title: 'Invoice for November',
      wake: true,
      wakeReason: 'unread important mail',
    })
    expect(record?.participants).toEqual(['billing@example.com', 'owner@example.com'])
    expect(seen.some(url => url.includes('/gmail/v1/users/me/messages?q=after'))).toBe(true)
    expect(seen.some(url => url.includes('format=metadata'))).toBe(true)
  })

  it('maps an imminent calendar event and leaves a distant event without a wake', async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({
      items: [
        {
          id: 'e1',
          summary: 'Design review',
          description: 'Review the connector index',
          location: 'Room 4',
          status: 'confirmed',
          updated: new Date(T0 - 60_000).toISOString(),
          start: { dateTime: new Date(T0 + 30 * 60_000).toISOString() },
          end: { dateTime: new Date(T0 + 60 * 60_000).toISOString() },
          organizer: { email: 'owner@example.com' },
          attendees: [{ email: 'guest@example.com' }],
          htmlLink: 'https://calendar.example/e1',
        },
        {
          id: 'e2',
          summary: 'Next quarter planning',
          status: 'confirmed',
          start: { dateTime: new Date(T0 + 10 * 86_400_000).toISOString() },
          end: { dateTime: new Date(T0 + 10 * 86_400_000 + 60 * 60_000).toISOString() },
        },
      ],
    }), { status: 200 })
    const api = new HttpGoogleWorkspaceApi(fixedToken, {
      fetch: fetchImpl,
      now: () => T0,
      apiBase: 'https://example.test',
    })
    const records = await api.fetch('calendar', query())
    expect(records[0]).toMatchObject({
      service: 'calendar',
      kind: 'event',
      externalId: 'e1',
      title: 'Design review',
      wake: true,
      wakeReason: 'calendar event starting soon',
    })
    expect(records[0]?.participants).toEqual(['owner@example.com', 'guest@example.com'])
    expect(records[1]?.wake).toBe(false)
  })

  it('maps Docs, Sheets, Slides, and Drive through the Drive endpoint', async () => {
    const seen: string[] = []
    const fetchImpl: FetchLike = async input => {
      seen.push(String(input))
      return new Response(JSON.stringify({
        files: [{
          id: 'doc-1',
          name: 'Shared roadmap',
          description: 'Connector notes',
          mimeType: 'application/vnd.google-apps.document',
          modifiedTime: new Date(T0 - 10 * 60_000).toISOString(),
          webViewLink: 'https://docs.example/doc-1',
          shared: true,
          owners: [{ emailAddress: 'owner@example.com' }],
          lastModifyingUser: { emailAddress: 'guest@example.com' },
        }],
      }), { status: 200 })
    }
    const api = new HttpGoogleWorkspaceApi(fixedToken, {
      fetch: fetchImpl,
      now: () => T0,
      apiBase: 'https://example.test',
    })
    const [doc] = await api.fetch('docs', query())
    expect(doc).toMatchObject({
      service: 'docs',
      kind: 'document',
      externalId: 'doc-1',
      title: 'Shared roadmap',
      wake: true,
      wakeReason: 'shared document changed by another person',
    })
    expect(seen[0]).toContain('mimeType')
    await api.fetch('sheets', query())
    await api.fetch('slides', query())
    await api.fetch('drive', query())
    expect(seen).toHaveLength(4)
  })

  it('maps a task due inside the lookahead window', async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({
      items: [{
        id: 'task-1',
        title: 'Send the contract',
        notes: 'Use the signed copy',
        due: new Date(T0 + 45 * 60_000).toISOString(),
        status: 'needsAction',
        updated: new Date(T0 - 60_000).toISOString(),
      }],
    }), { status: 200 })
    const api = new HttpGoogleWorkspaceApi(fixedToken, {
      fetch: fetchImpl,
      now: () => T0,
      apiBase: 'https://example.test',
    })
    const [task] = await api.fetch('tasks', query())
    expect(task).toMatchObject({
      service: 'tasks',
      kind: 'task',
      externalId: 'task-1',
      title: 'Send the contract',
      wake: true,
      wakeReason: 'task due soon',
    })
  })

  it('rechecks unchanged tasks and treats provider midnight-Z due dates as a whole day', async () => {
    let requested: URL | undefined
    const fetchImpl: FetchLike = async input => {
      requested = new URL(String(input))
      return new Response(JSON.stringify({
        items: [{
          id: 'unchanged-task',
          title: 'Synthetic due-today task',
          due: '2026-11-05T00:00:00.000Z',
          status: 'needsAction',
          updated: '2026-10-01T00:00:00.000Z',
        }],
      }), { status: 200 })
    }
    const api = new HttpGoogleWorkspaceApi(fixedToken, {
      fetch: fetchImpl,
      now: () => T0,
      apiBase: 'https://example.test',
    })
    const [task] = await api.fetch('tasks', query())
    expect(requested?.searchParams.has('updatedMin')).toBe(false)
    expect(task).toMatchObject({ externalId: 'unchanged-task', wake: true })
  })

  it('keeps non-midnight RFC 3339 due times as instants', async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({
      items: [{
        id: 'timed-task',
        title: 'Synthetic overdue timed task',
        due: '2026-11-05T00:30:00.000Z',
        status: 'needsAction',
      }],
    }), { status: 200 })
    const api = new HttpGoogleWorkspaceApi(fixedToken, {
      fetch: fetchImpl,
      now: () => T0,
      apiBase: 'https://example.test',
    })
    const [task] = await api.fetch('tasks', query())
    expect(task).toMatchObject({ externalId: 'timed-task', wake: false })
  })

  it('signals rejected Drive-family continuation tokens distinctly', async () => {
    const services = ['drive', 'docs', 'sheets', 'slides'] as const
    for (const service of services) {
      const api = new HttpGoogleWorkspaceApi(fixedToken, {
        fetch: async () => new Response(JSON.stringify({
          error: { code: 400, message: 'Invalid Value' },
        }), { status: 400 }),
        apiBase: 'https://example.test',
      })
      await expect(api.fetchPage(service, query({ pageToken: 'expired-token' })))
        .rejects.toBeInstanceOf(GoogleInvalidPageTokenError)
    }
  })
})

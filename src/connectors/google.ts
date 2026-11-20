import { oneLine, type ConnectorDraft, type GoogleService } from './types.ts'
import type { GoogleTokenProvider } from './oauth.ts'
import type { FetchLike } from './oauth.ts'

/**
 * Read-only Google Workspace mapping.
 *
 * The class is an adapter, not an authority: it turns public REST payloads into
 * `ConnectorDraft`s and leaves admission, quiet hours, caps, thread selection,
 * and delivery to the Runtime pipeline. Tests exercise it with a fake `fetch`;
 * a real Google account is not part of the offline acceptance.
 */

export interface GoogleFetchQuery {
  /** Inclusive lower bound supplied by the scheduler (ISO 8601). */
  since: string
  /** Poll time (ISO 8601). */
  until: string
  /** Per-service provider page size and maximum records handled this poll. */
  limit: number
  /** Provider continuation token from the previous bounded poll. */
  pageToken?: string
  /** Imminent-event / due-task window. */
  lookaheadMinutes: number
  signal?: AbortSignal
}

export interface GoogleFetchPage {
  drafts: ConnectorDraft[]
  nextPageToken?: string
}

/** Match the provider's Calendar wake contract, including its 15-minute grace. */
export function calendarEventWakeDeadline(startMs: number): number | undefined {
  return Number.isFinite(startMs) ? startMs + 15 * 60_000 : undefined
}

export function calendarEventWakeEligible(startMs: number, now: number, lookaheadMinutes: number): boolean {
  const deadline = calendarEventWakeDeadline(startMs)
  return deadline !== undefined
    && now <= deadline
    && startMs <= now + lookaheadMinutes * 60_000
}

export class GoogleInvalidPageTokenError extends Error {
  constructor(readonly path: string) {
    super(`google api ${path} rejected page token`)
    this.name = 'GoogleInvalidPageTokenError'
  }
}

export interface GoogleWorkspaceApi {
  fetch(service: GoogleService, query: GoogleFetchQuery): Promise<ConnectorDraft[]>
  fetchPage?(service: GoogleService, query: GoogleFetchQuery): Promise<GoogleFetchPage>
}

export interface HttpGoogleWorkspaceApiOptions {
  fetch?: FetchLike
  now?: () => number
  /** Override for tests; defaults to the public Google API host. */
  apiBase?: string
  requestTimeoutMs?: number
}

const API_BASE = 'https://www.googleapis.com'
const DRIVE_FIELDS = [
  'nextPageToken',
  'files(id,name,description,mimeType,modifiedTime,createdTime,webViewLink,shared,trashed',
  'owners(emailAddress,displayName),lastModifyingUser(emailAddress,displayName))',
].join(',')
const DOC_MIME: Partial<Record<GoogleService, string>> = {
  docs: 'application/vnd.google-apps.document',
  sheets: 'application/vnd.google-apps.spreadsheet',
  slides: 'application/vnd.google-apps.presentation',
}

export class HttpGoogleWorkspaceApi implements GoogleWorkspaceApi {
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly apiBase: string
  private readonly requestTimeoutMs: number

  constructor(
    private readonly tokenProvider: GoogleTokenProvider,
    options: HttpGoogleWorkspaceApiOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.apiBase = (options.apiBase ?? API_BASE).replace(/\/+$/, '')
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000
  }

  async fetch(service: GoogleService, query: GoogleFetchQuery): Promise<ConnectorDraft[]> {
    return (await this.fetchPage(service, query)).drafts
  }

  async fetchPage(service: GoogleService, query: GoogleFetchQuery): Promise<GoogleFetchPage> {
    switch (service) {
      case 'calendar': return this.calendar(query)
      case 'gmail': return this.gmail(query)
      case 'drive':
      case 'docs':
      case 'sheets':
      case 'slides':
        return this.drive(service, query)
      case 'tasks': return this.tasks(query)
    }
  }

  private async calendar(query: GoogleFetchQuery): Promise<GoogleFetchPage> {
    const queryAt = Date.parse(query.until)
    const indexedAt = Number.isFinite(queryAt) ? queryAt : this.now()
    const now = Math.max(indexedAt, this.now())
    const replay = unwrapCalendarReplayToken(query.pageToken)
    // The paged index query retains its original bounds. A separate bounded
    // query prioritizes imminent events so older results cannot hide them on a
    // later page until after their start time. If urgent results displace index
    // records, replay that index page without the urgent query on the next poll.
    const indexWindowMinutes = Math.max(query.lookaheadMinutes, 7 * 24 * 60)
    const data = await this.get('/calendar/v3/calendars/primary/events', {
      timeMin: new Date(indexedAt - 24 * 60 * 60_000).toISOString(),
      timeMax: new Date(indexedAt + indexWindowMinutes * 60_000).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(query.limit),
      showDeleted: 'false',
      pageToken: replay.pageToken,
    }, query.signal)
    const urgent = replay.replay ? { items: [] } : await this.get('/calendar/v3/calendars/primary/events', {
      timeMin: new Date(now - 15 * 60_000).toISOString(),
      timeMax: new Date(now + query.lookaheadMinutes * 60_000).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '2500',
      showDeleted: 'false',
    }, query.signal)
    const unique = new Map<string, unknown>()
    const indexIds = new Set<string>()
    const eventKey = (item: unknown): string => {
      const event = record(item)
      const start = dateTimeOf(event.start) ?? str(record(event.start).date)
      return str(event.id) ?? start ?? JSON.stringify(item)
    }
    for (const item of arrayOf(urgent, 'items')) {
      const id = eventKey(item)
      if (!unique.has(id)) unique.set(id, item)
    }
    for (const item of arrayOf(data, 'items')) {
      const id = eventKey(item)
      indexIds.add(id)
      if (!unique.has(id)) unique.set(id, item)
    }
    const selected = [...unique.entries()].slice(0, query.limit)
    const selectedIds = new Set(selected.map(([id]) => id))
    const omittedIndexRecord = [...indexIds].some(id => !selectedIds.has(id))
    const drafts: ConnectorDraft[] = []
    for (const [, item] of selected) {
      const event = record(item)
      const start = dateTimeOf(event.start) ?? str(record(event.start).date)
      const end = dateTimeOf(event.end) ?? str(record(event.end).date)
      if (!start) continue
      const startMs = Date.parse(start)
      const status = str(event.status)
      const title = oneLine(str(event.summary) ?? 'Untitled event', 160)
      const description = str(event.description) ?? ''
      const location = str(event.location)
      const organizer = str(record(event.organizer).email)
      const attendees = arrayOf(event, 'attendees')
        .map(entry => str(record(entry).email))
        .filter((value): value is string => Boolean(value))
      const participants = [organizer, ...attendees].filter((value): value is string => Boolean(value))
      const imminent = calendarEventWakeEligible(startMs, now, query.lookaheadMinutes)
      drafts.push({
        service: 'calendar',
        kind: 'event',
        externalId: str(event.id) ?? `${start}`,
        title,
        text: oneLine([description, location ? `location=${location}` : ''].filter(Boolean).join(' '), 600),
        occurredAt: start,
        updatedAt: str(event.updated) ?? start,
        ...(str(event.htmlLink) ? { url: str(event.htmlLink)! } : {}),
        ...(participants.length ? { participants } : {}),
        ...(end ? { labels: [`ends:${end}`] } : {}),
        wake: status !== 'cancelled' && imminent,
        ...(status !== 'cancelled' && imminent ? { wakeReason: 'calendar event starting soon' } : {}),
      })
    }
    const nextPageToken = omittedIndexRecord
      ? calendarReplayToken(replay.pageToken)
      : str(record(data).nextPageToken)
    return { drafts, ...(nextPageToken ? { nextPageToken } : {}) }
  }

  private async gmail(query: GoogleFetchQuery): Promise<GoogleFetchPage> {
    const after = Math.max(0, Math.floor((Date.parse(query.since) - 60_000) / 1_000))
    const list = await this.get('/gmail/v1/users/me/messages', {
      q: `after:${after}`,
      maxResults: String(query.limit),
      includeSpamTrash: 'false',
      pageToken: query.pageToken,
    }, query.signal)
    const stubs = arrayOf(list, 'messages')
    const drafts: ConnectorDraft[] = []
    for (const stub of stubs.slice(0, query.limit)) {
      const id = str(record(stub).id)
      if (!id) continue
      const message = record(await this.get(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}`, {
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'To', 'Date'],
      }, query.signal))
      const headers = headerMap(message)
      const labels = arrayOf(message, 'labelIds')
        .map(entry => str(entry))
        .filter((value): value is string => Boolean(value))
      const at = Number(str(message.internalDate))
      const occurredAt = Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : query.until
      const from = headers.from ?? ''
      const to = headers.to ?? ''
      const subject = oneLine(headers.subject ?? '(no subject)', 180)
      const wanted = labels.includes('UNREAD') && labels.includes('IMPORTANT') && !labels.includes('SENT')
      drafts.push({
        service: 'gmail',
        kind: 'message',
        externalId: str(message.id) ?? id,
        title: subject,
        text: oneLine([from ? `from=${from}` : '', str(message.snippet) ?? ''].filter(Boolean).join(' '), 600),
        occurredAt,
        updatedAt: occurredAt,
        participants: splitAddresses(`${from},${to}`),
        labels,
        wake: wanted,
        ...(wanted ? { wakeReason: 'unread important mail' } : {}),
      })
    }
    return { drafts, ...(str(record(list).nextPageToken) ? { nextPageToken: str(record(list).nextPageToken)! } : {}) }
  }

  private async drive(service: GoogleService, query: GoogleFetchQuery): Promise<GoogleFetchPage> {
    const conditions = [`modifiedTime > '${query.since}'`, 'trashed = false']
    const mime = DOC_MIME[service]
    if (mime) conditions.push(`mimeType = '${mime}'`)
    const data = await this.get('/drive/v3/files', {
      q: conditions.join(' and '),
      orderBy: 'modifiedTime desc',
      pageSize: String(query.limit),
      fields: DRIVE_FIELDS,
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true',
      pageToken: query.pageToken,
    }, query.signal)
    const drafts: ConnectorDraft[] = []
    for (const item of arrayOf(data, 'files').slice(0, query.limit)) {
      const file = record(item)
      const id = str(file.id)
      const modifiedAt = str(file.modifiedTime)
      if (!id || !modifiedAt) continue
      const ownerEmail = str(record(arrayOf(file, 'owners')[0]).emailAddress)
      const lastEditor = str(record(file.lastModifyingUser).emailAddress)
      const shared = file.shared === true
      const changedByOther = Boolean(lastEditor) && Boolean(ownerEmail) && lastEditor !== ownerEmail
      const wanted = Boolean(mime) && shared && changedByOther
      const name = oneLine(str(file.name) ?? 'Untitled file', 180)
      const description = str(file.description) ?? ''
      drafts.push({
        service,
        kind: mime ? 'document' : 'file',
        externalId: id,
        title: name,
        text: oneLine([
          description,
          changedByOther ? `lastEditor=${lastEditor}` : '',
          shared ? 'shared=true' : '',
        ].filter(Boolean).join(' '), 600),
        occurredAt: modifiedAt,
        updatedAt: modifiedAt,
        ...(str(file.webViewLink) ? { url: str(file.webViewLink)! } : {}),
        participants: [ownerEmail, lastEditor].filter((value): value is string => Boolean(value)),
        labels: [str(file.mimeType) ?? 'file'],
        wake: wanted,
        ...(wanted ? { wakeReason: 'shared document changed by another person' } : {}),
      })
    }
    return { drafts, ...(str(record(data).nextPageToken) ? { nextPageToken: str(record(data).nextPageToken)! } : {}) }
  }

  private async tasks(query: GoogleFetchQuery): Promise<GoogleFetchPage> {
    const now = this.now()
    const data = await this.get('/tasks/v1/lists/@default/tasks', {
      // Due dates are independent of update time; keep active tasks visible as
      // they approach their deadlines even when the task itself is unchanged.
      showCompleted: 'false',
      showHidden: 'false',
      maxResults: String(query.limit),
      pageToken: query.pageToken,
    }, query.signal)
    const drafts: ConnectorDraft[] = []
    for (const item of arrayOf(data, 'items').slice(0, query.limit)) {
      const task = record(item)
      const id = str(task.id)
      if (!id) continue
      const due = str(task.due)
      const updatedAt = str(task.updated) ?? due ?? query.until
      const dueMs = due ? Date.parse(due) : Number.NaN
      const wholeUtcDate = due !== undefined && (
        /^\d{4}-\d{2}-\d{2}$/.test(due)
        || /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0+)?(?:Z|\+00:00|\+0000)$/i.test(due)
      )
      const dueEndMs = wholeUtcDate ? dueMs + 86_400_000 - 1 : dueMs
      const soon = Number.isFinite(dueMs)
        && dueEndMs >= now - 60_000
        && dueMs <= now + query.lookaheadMinutes * 60_000
      const status = str(task.status) ?? 'needsAction'
      const wanted = soon && status !== 'completed'
      drafts.push({
        service: 'tasks',
        kind: 'task',
        externalId: id,
        title: oneLine(str(task.title) ?? 'Untitled task', 180),
        text: oneLine([
          str(task.notes) ?? '',
          due ? `due=${due}` : '',
          `status=${status}`,
        ].filter(Boolean).join(' '), 600),
        occurredAt: due ?? updatedAt,
        updatedAt,
        ...(str(task.webViewLink) ? { url: str(task.webViewLink)! } : {}),
        labels: [status],
        wake: wanted,
        ...(wanted ? { wakeReason: 'task due soon' } : {}),
      })
    }
    return { drafts, ...(str(record(data).nextPageToken) ? { nextPageToken: str(record(data).nextPageToken)! } : {}) }
  }

  private async get(
    path: string,
    params: Record<string, string | string[] | undefined>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(`${this.apiBase}${path}`)
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue
      if (Array.isArray(value)) {
        for (const entry of value) url.searchParams.append(key, entry)
      } else {
        url.searchParams.set(key, value)
      }
    }
    const response = await this.request(url, signal, true)
    if (response.status === 401) {
      // A cached token can expire between checks. Retry once with a fresh one.
      this.tokenProvider.invalidate()
      const retried = await this.request(url, signal, false)
      return parseJson(retried, path, Boolean(params.pageToken))
    }
    return parseJson(response, path, Boolean(params.pageToken))
  }

  private async request(url: URL, signal: AbortSignal | undefined, allowRefresh: boolean): Promise<Response> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const token = await this.tokenProvider.accessToken(combined)
    const response = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
      signal: combined,
    })
    if (response.status === 401 && allowRefresh) return response
    return response
  }
}

async function parseJson(response: Response, path: string, hasPageToken = false): Promise<unknown> {
  if (!response.ok) {
    const body = await response.text()
    const invalidToken = response.status === 400 && hasPageToken && (
      (/page[\s_-]?token/i.test(body) && /(invalid|expired|unknown|not valid|unsupported)/i.test(body))
      || /invalid value/i.test(body)
    )
    if (invalidToken) throw new GoogleInvalidPageTokenError(path)
    throw new Error(`google api ${path} failed status=${response.status}`)
  }
  return await response.json()
}

const CALENDAR_REPLAY_PREFIX = 'dsh-calendar-index-replay:'

function calendarReplayToken(pageToken?: string): string {
  return `${CALENDAR_REPLAY_PREFIX}${encodeURIComponent(pageToken ?? '')}`
}

function unwrapCalendarReplayToken(pageToken?: string): { replay: boolean; pageToken?: string } {
  if (!pageToken?.startsWith(CALENDAR_REPLAY_PREFIX)) {
    return { replay: false, ...(pageToken ? { pageToken } : {}) }
  }
  const encoded = pageToken.slice(CALENDAR_REPLAY_PREFIX.length)
  const replayToken = decodeURIComponent(encoded)
  return { replay: true, ...(replayToken ? { pageToken: replayToken } : {}) }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function arrayOf(value: unknown, key: string): unknown[] {
  const candidate = record(value)[key]
  return Array.isArray(candidate) ? candidate : []
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function dateTimeOf(value: unknown): string | undefined {
  return str(record(value).dateTime)
}

function headerMap(message: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {}
  const payload = record(message.payload)
  for (const entry of arrayOf(payload, 'headers')) {
    const header = record(entry)
    const name = str(header.name)?.toLowerCase()
    const value = str(header.value)
    if (name && value) headers[name] = value
  }
  return headers
}

function splitAddresses(value: string): string[] {
  const found = new Set<string>()
  for (const match of value.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    found.add(match[0])
  }
  return [...found]
}

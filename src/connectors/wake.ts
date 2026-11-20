import { admissionDenial, type AdmissionRules } from '../ingress/filter.ts'
import { dayKey, PROACTIVE_TRIGGER_PREFIX, withinQuietHours, type ProactiveConfig } from '../harness/proactive.ts'
import type { Disposition, Ticket, Trigger } from '../shared/types.ts'
import type { Store } from '../store/sqlite.ts'
import type { ConnectorConfig, ConnectorWakeConfig } from './config.ts'
import { ConnectorIndex } from './index-store.ts'
import { GoogleInvalidPageTokenError, type GoogleWorkspaceApi } from './google.ts'
import {
  connectorRecordId,
  oneLine,
  type ConnectorDraft,
  type ConnectorRecord,
  type GoogleService,
} from './types.ts'

/**
 * Connector/event wake.
 *
 * This is the only place connector data can ask for the owner's attention. It
 * is driven by the existing Daemon pulse: no timer, no second agent loop, and
 * no Worker. A due round polls the owner-authorized services, writes the
 * records to the connector index, and at most one concrete record may become
 * an ordinary Trigger through `Runtime.ingest`. Everything after that is the
 * normal admission, Router, approval, and outbox path.
 *
 * Silence is the default:
 * - the first round is a backfill and never wakes;
 * - quiet hours come from the existing `proactive.json` window;
 * - min-interval and daily caps are persisted;
 * - the target must be an already-admitted private thread;
 * - DROP_SELF, actor allowlists, and group allowlists are checked before fire;
 * - a record without the provider's usefulness signal is only indexed.
 */

export const CONNECTOR_WAKE_STATE_KIND = 'connector_wake'
export const CONNECTOR_WAKE_STATE_ID = 'state'
export const CONNECTOR_TRIGGER_PREFIX = 'trg_connector_'
export const CONNECTOR_CHANNEL_MARKER = 'connector'

const MAX_WAKE_ROWS = 64
const MAX_NOTIFIED_ROWS = 256
const WAKE_RETENTION_MS = 7 * 86_400_000
const NOTIFIED_RETENTION_MS = 30 * 86_400_000
const CURSOR_OVERLAP_MS = 5 * 60_000

export interface ConnectorWakeRow {
  at: number
  triggerId: string
  recordId: string
  service: GoogleService
}

export interface ConnectorNotifiedRow {
  at: number
  triggerId: string
}

export interface ConnectorPendingWake {
  at: number
  trigger: Trigger
  recordId: string
  service: GoogleService
}

export interface ConnectorWakeState {
  lastCheckAt?: number
  lastWakeAt?: number
  backfillPending?: boolean
  cursors?: Partial<Record<GoogleService, string>>
  pageTokens?: Partial<Record<GoogleService, string>>
  pageQueries?: Partial<Record<GoogleService, { since: string; until: string }>>
  invalidPageTokens?: Partial<Record<GoogleService, string>>
  invalidTokenRetries?: Partial<Record<GoogleService, number>>
  invalidTokenRetryAfter?: Partial<Record<GoogleService, number>>
  pending?: ConnectorPendingWake[]
  wakes: ConnectorWakeRow[]
  notified: ConnectorNotifiedRow[]
}

export type ConnectorWakeAction =
  | 'disabled'
  | 'in-flight'
  | 'armed'
  | 'not-due'
  | 'clock-backwards'
  | 'backfill'
  | 'polled'
  | 'quiet-hours'
  | 'min-interval'
  | 'daily-cap'
  | 'no-target'
  | 'admission-denied'
  | 'silent'
  | 'wake'

export interface ConnectorWakeResult {
  action: ConnectorWakeAction
  indexed?: number
  inserted?: number
  updated?: number
  skipped?: number
  serviceErrors?: string[]
  recordId?: string
  trigger?: Trigger
  reason?: string
}

export interface ConnectorWakeSchedulerOptions {
  now: () => number
  store: Store
  config: ConnectorConfig
  index: ConnectorIndex
  api?: GoogleWorkspaceApi
  /** Existing quiet-hours window and timezone. */
  proactive: ProactiveConfig
  admission?: AdmissionRules
  env?: NodeJS.ProcessEnv
  /** Must be the Runtime ingress path. */
  fire: (trigger: Trigger) => void
  log?: (line: string) => void
}

export interface WakeTarget {
  channel: NonNullable<Trigger['channel']>
  actor: Trigger['actor']
}

export class ConnectorWakeScheduler {
  private readonly log: (line: string) => void
  private inFlight?: Promise<void>

  constructor(private readonly opts: ConnectorWakeSchedulerOptions) {
    this.log = opts.log ?? (() => undefined)
  }

  /** Daemon pulse entry point. It never awaits; the guard prevents overlap. */
  tick(at = this.opts.now()): void {
    void this.poll(at).catch(error => {
      this.log(`[connector] tick failed: ${messageOf(error)}`)
    })
  }

  /** Deterministic unit-test entry point with the same guard as `tick`. */
  async poll(at = this.opts.now()): Promise<ConnectorWakeResult> {
    if (this.inFlight) return { action: 'in-flight' }
    const run = this.runPoll(at)
    this.inFlight = run.then(() => undefined, () => undefined)
    try {
      return await run
    } finally {
      this.inFlight = undefined
    }
  }

  private async runPoll(at: number): Promise<ConnectorWakeResult> {
    const config = this.opts.config
    const api = this.opts.api
    let state = this.loadState()
    const replayAt = Math.max(at, this.opts.now())
    state = this.reconcilePending(state, replayAt, config.enabled && Boolean(api))
    if (!config.enabled) return { action: 'disabled' }
    if (!api) return { action: 'disabled', reason: 'no-api' }
    const initialBackfillServices = new Set(
      config.google.services.filter(service => state.cursors?.[service] === undefined),
    )
    const first = state.lastCheckAt === undefined
    const allServicesBackfilling = config.google.services.length > 0
      && initialBackfillServices.size === config.google.services.length
    if (!first) {
      if (typeof state.lastCheckAt !== 'number' || !Number.isFinite(state.lastCheckAt)) {
        this.saveState({ ...state, lastCheckAt: at })
        this.log('[connector] invalid lastCheckAt; re-armed')
        return { action: 'armed' }
      }
      if (at < state.lastCheckAt) {
        const interval = config.poll.intervalMinutes * 60_000
        if (state.lastCheckAt - at > Math.max(2 * interval, 10 * 60_000)) {
          this.saveState({ ...state, lastCheckAt: at })
          this.log(`[connector] clock moved backwards by=${state.lastCheckAt - at}ms; re-armed`)
          return { action: 'clock-backwards' }
        }
        this.log('[connector] clock moved backwards; skipping')
        return { action: 'not-due' }
      }
      if (at - state.lastCheckAt < config.poll.intervalMinutes * 60_000) {
        return { action: 'not-due' }
      }
    }

    const until = new Date(at).toISOString()
    const lookbackMs = config.wake.lookbackMinutes * 60_000
    const cursors: Partial<Record<GoogleService, string>> = { ...(state.cursors ?? {}) }
    const pageTokens: Partial<Record<GoogleService, string>> = { ...(state.pageTokens ?? {}) }
    const pageQueries: Partial<Record<GoogleService, { since: string; until: string }>> = { ...(state.pageQueries ?? {}) }
    const invalidPageTokens: Partial<Record<GoogleService, string>> = { ...(state.invalidPageTokens ?? {}) }
    const invalidTokenRetries: Partial<Record<GoogleService, number>> = { ...(state.invalidTokenRetries ?? {}) }
    const invalidTokenRetryAfter: Partial<Record<GoogleService, number>> = { ...(state.invalidTokenRetryAfter ?? {}) }
    const drafts: ConnectorDraft[] = []
    const serviceErrors: string[] = []
    for (const service of config.google.services) {
      if ((invalidTokenRetryAfter[service] ?? 0) > at) {
        this.log(`[connector] page-token retry deferred service=${service} until=${new Date(invalidTokenRetryAfter[service]!).toISOString()}`)
        continue
      }
      const previous = cursors[service]
      const previousMs = previous === undefined ? Number.NaN : Date.parse(previous)
      const since = Number.isFinite(previousMs)
        ? new Date(previousMs - CURSOR_OVERLAP_MS).toISOString()
        : new Date(at - lookbackMs).toISOString()
      const pageQuery = pageQueries[service]
      const query = {
        since: pageQuery?.since ?? since,
        until: pageQuery?.until ?? until,
        limit: config.poll.maxRecordsPerPoll,
        lookaheadMinutes: config.wake.calendarLookaheadMinutes,
        ...(pageTokens[service] ? { pageToken: pageTokens[service] } : {}),
      }
      try {
        const page = api.fetchPage
          ? await api.fetchPage(service, query)
          : { drafts: await api.fetch(service, query) }
        drafts.push(...page.drafts.slice(0, config.poll.maxRecordsPerPoll))
        if (page.nextPageToken) {
          pageTokens[service] = page.nextPageToken
          pageQueries[service] = { since: query.since, until: query.until }
          if (page.nextPageToken !== invalidPageTokens[service]) {
            delete invalidPageTokens[service]
            delete invalidTokenRetries[service]
            delete invalidTokenRetryAfter[service]
          }
        } else {
          delete pageTokens[service]
          delete pageQueries[service]
          delete invalidPageTokens[service]
          delete invalidTokenRetries[service]
          delete invalidTokenRetryAfter[service]
          // Advance the time cursor only after the provider reports the page is
          // complete. Continuations retain the original provider query bounds.
          cursors[service] = query.until
        }
      } catch (error) {
        serviceErrors.push(`${service}: ${messageOf(error)}`)
        this.log(`[connector] poll failed service=${service}: ${messageOf(error)}`)
        if (error instanceof GoogleInvalidPageTokenError) {
          delete pageTokens[service]
          pageQueries[service] = { since: query.since, until: query.until }
          if (query.pageToken) {
            const retries = (invalidPageTokens[service] === query.pageToken
              ? invalidTokenRetries[service] ?? 0
              : 0) + 1
            invalidPageTokens[service] = query.pageToken
            invalidTokenRetries[service] = retries
            const backoffMs = Math.min(
              24 * 60 * 60_000,
              config.poll.intervalMinutes * 60_000 * 2 ** Math.min(retries - 1, 8),
            )
            invalidTokenRetryAfter[service] = at + backoffMs
            this.log(`[connector] rejected page token service=${service} retries=${retries} retry-after=${new Date(at + backoffMs).toISOString()}`)
          }
        } else if (cursors[service] === undefined) {
          pageQueries[service] = { since: query.since, until: query.until }
        }
      }
    }

    const decisionAt = Math.max(at, this.opts.now())
    const upsert = this.opts.index.upsert(drafts)
    const pruned = this.opts.index.prune(config.index)
    const base: ConnectorWakeState = {
      ...state,
      lastCheckAt: decisionAt,
      // Keep the previously committed checkpoints until the new page state is
      // saved; a wake page is saved together with its durable outbox row.
      cursors: state.cursors,
      pageTokens: state.pageTokens,
      pageQueries: state.pageQueries,
      wakes: state.wakes
        .filter(row => decisionAt - row.at <= WAKE_RETENTION_MS)
        .slice(-MAX_WAKE_ROWS),
      notified: state.notified
        .filter(row => decisionAt - row.at <= NOTIFIED_RETENTION_MS)
        .slice(-MAX_NOTIFIED_ROWS),
    }
    const counts = {
      indexed: upsert.records.length,
      inserted: upsert.inserted,
      updated: upsert.updated,
      skipped: upsert.skipped,
      ...(serviceErrors.length ? { serviceErrors } : {}),
    }
    const committed = (): ConnectorWakeState => ({
      ...base,
      cursors,
      pageTokens: Object.keys(pageTokens).length ? pageTokens : undefined,
      pageQueries: Object.keys(pageQueries).length ? pageQueries : undefined,
      invalidPageTokens: Object.keys(invalidPageTokens).length ? invalidPageTokens : undefined,
      invalidTokenRetries: Object.keys(invalidTokenRetries).length ? invalidTokenRetries : undefined,
      invalidTokenRetryAfter: Object.keys(invalidTokenRetryAfter).length ? invalidTokenRetryAfter : undefined,
      backfillPending: config.google.services.some(service => cursors[service] === undefined)
        || Object.keys(pageTokens).length > 0,
    })
    if (pruned > 0) this.log(`[connector] index pruned=${pruned}`)

    // Establish each service's initial index before treating its historic rows
    // as new wake candidates. A failed service does not block other services.
    const known = new Set(base.notified.map(row => row.triggerId))
    for (const record of upsert.records) {
      if (!initialBackfillServices.has(record.service)
        || !record.wake
        || !config.wake.services.includes(record.service)) continue
      const triggerId = connectorRevisionTriggerId(record)
      if (!known.has(triggerId)) {
        base.notified.push({ at: decisionAt, triggerId })
        known.add(triggerId)
      }
    }
    base.notified = base.notified.slice(-MAX_NOTIFIED_ROWS)

    // The first round only establishes the index and cursors. Waking from a
    // historical batch would be a burst, not a useful event.
    if (first || allServicesBackfilling) {
      this.saveState(committed())
      this.log(
        `[connector] backfill indexed=${upsert.records.length} inserted=${upsert.inserted} `
        + `services=${config.google.services.join(',')}`,
      )
      return { action: 'backfill', ...counts }
    }
    if (base.pending?.length) {
      this.saveState(committed())
      const pending = base.pending[0]!
      this.log(`[connector] wake selection suppressed pending triggerId=${pending.trigger.id}`)
      return { action: 'wake', recordId: pending.recordId, trigger: pending.trigger, ...counts }
    }
    if (!config.wake.enabled) {
      this.saveState(committed())
      this.log(`[connector] index-only indexed=${upsert.records.length} inserted=${upsert.inserted}`)
      return { action: 'polled', ...counts }
    }
    if (withinQuietHours(decisionAt, this.opts.proactive)) {
      this.saveState(committed())
      this.log(`[connector] quiet-hours now=${localTime(decisionAt, this.opts.proactive.timezone)}`)
      return { action: 'quiet-hours', ...counts }
    }

    const wakeConfig = config.wake
    if (
      base.lastWakeAt !== undefined
      && decisionAt - base.lastWakeAt < wakeConfig.minIntervalMinutes * 60_000
    ) {
      this.saveState(committed())
      this.log(`[connector] min-interval lastWakeAt=${new Date(base.lastWakeAt).toISOString()}`)
      return { action: 'min-interval', ...counts }
    }
    const today = dayKey(decisionAt, this.opts.proactive.timezone)
    const todayWakes = base.wakes.filter(row => dayKey(row.at, this.opts.proactive.timezone) === today)
    if (todayWakes.length >= wakeConfig.maxPerDay) {
      this.saveState(committed())
      this.log(`[connector] daily-cap count=${todayWakes.length} max=${wakeConfig.maxPerDay}`)
      return { action: 'daily-cap', ...counts }
    }

    const target = this.findWakeTarget(wakeConfig)
    if (!target) {
      this.saveState(committed())
      this.log(`[connector] silent reason=no-private-thread source=${wakeConfig.source} thread=${wakeConfig.thread}`)
      return { action: 'no-target', ...counts }
    }

    const recordById = new Map(upsert.records.map(record => [record.id, record]))
    const candidates = drafts
      .filter(draft => draft.wake === true && wakeConfig.services.includes(draft.service))
      .map(draft => recordById.get(connectorRecordId(draft.service, draft.externalId.trim())))
      .filter((record): record is ConnectorRecord => record !== undefined)
      .sort((left, right) =>
        right.occurredAt.localeCompare(left.occurredAt)
        || right.updatedAt.localeCompare(left.updatedAt)
        || right.id.localeCompare(left.id))

    let denied: string | undefined
    for (const record of candidates) {
      const trigger = connectorTrigger(record, target, decisionAt)
      if (base.notified.some(row => row.triggerId === trigger.id)) continue
      // A previously persisted trigger is already decided. Do not spend a
      // second wake on the same source revision.
      if (this.opts.store.getDoc<Trigger>('trigger', trigger.id)) {
        base.notified = [...base.notified, { at: decisionAt, triggerId: trigger.id }].slice(-MAX_NOTIFIED_ROWS)
        continue
      }
      const reason = admissionDenial(trigger, this.opts.admission)
      if (reason) {
        denied = reason
        this.log(`[connector] wake suppressed triggerId=${trigger.id} reason=${reason}`)
        continue
      }
      const pending: ConnectorPendingWake = { at: decisionAt, trigger, recordId: record.id, service: record.service }
      this.saveState({ ...committed(), pending: [...(base.pending ?? []), pending] })
      try {
        this.opts.fire(trigger)
      } catch (error) {
        this.log(`[connector] fire deferred triggerId=${trigger.id}: ${messageOf(error)}`)
        return { action: 'wake', recordId: record.id, trigger, ...counts }
      }
      if (!this.ingressComplete(trigger.id)) {
        this.log(`[connector] ingress did not complete triggerId=${trigger.id}; wake remains pending`)
        return { action: 'wake', recordId: record.id, trigger, ...counts }
      }
      this.finishPending(this.loadState(), pending)
      this.log(
        `[connector] wake service=${record.service} recordId=${record.id} `
        + `triggerId=${trigger.id} source=${target.channel.source} thread=${target.channel.thread}`,
      )
      return { action: 'wake', recordId: record.id, trigger, ...counts }
    }

    this.saveState(committed())
    if (denied) {
      this.log(`[connector] silent reason=${denied}`)
      return { action: 'admission-denied', reason: denied, ...counts }
    }
    this.log('[connector] silent reason=no-useful-record')
    return { action: 'silent', ...counts }
  }

  private findWakeTarget(wake: ConnectorWakeConfig): WakeTarget | undefined {
    const env = this.opts.env ?? process.env
    const candidates: { trigger: Trigger; at: number }[] = []
    for (const trigger of this.opts.store.listDocs<Trigger>('trigger')) {
      if (trigger.human !== true) continue
      if (trigger.id.startsWith(PROACTIVE_TRIGGER_PREFIX)) continue
      if (trigger.id.startsWith(CONNECTOR_TRIGGER_PREFIX)) continue
      const channel = trigger.channel
      if (!channel || channel.source !== wake.source || channel.thread !== wake.thread) continue
      const disposition = this.opts.store.getDoc<Disposition>('disposition', trigger.id)
      if (!disposition || disposition.filtered !== undefined) continue
      const at = Date.parse(trigger.at)
      if (!Number.isFinite(at)) continue
      candidates.push({ trigger, at })
    }
    candidates.sort((left, right) => right.at - left.at)
    for (const candidate of candidates) {
      const channel = candidate.trigger.channel
      if (!channel || !isPrivateTarget(channel, wake, env)) continue
      return { channel, actor: candidate.trigger.actor }
    }
    return undefined
  }

  private reconcilePending(state: ConnectorWakeState, decisionAt: number, enabled: boolean): ConnectorWakeState {
    for (const pending of state.pending ?? []) {
      if (!this.ingressComplete(pending.trigger.id)) {
        const reason = this.pendingAuthorizationReason(state, pending, decisionAt, enabled)
        if (reason === 'private-target-changed' || reason === 'no-current-private-target') {
          // The ingress was authorized for a specific private recipient. Retire
          // it when that recipient is no longer current; never replay it to the
          // old target, and do not let its outbox row block unrelated wakes.
          state = this.retireStaleTargetPending(state, pending, decisionAt, reason)
          continue
        }
        if (reason) {
          this.log(`[connector] pending wake held triggerId=${pending.trigger.id} reason=${reason}`)
          break
        }
        try {
          // Runtime ingress recognizes a persisted trigger without a disposition
          // as an interrupted commit and resumes it idempotently.
          this.opts.fire(pending.trigger)
        } catch (error) {
          this.log(`[connector] pending wake retry failed triggerId=${pending.trigger.id}: ${messageOf(error)}`)
          break
        }
      }
      if (!this.ingressComplete(pending.trigger.id)) break
      state = this.finishPending(state, pending)
    }
    return state
  }

  private pendingAuthorizationReason(
    state: ConnectorWakeState,
    pending: ConnectorPendingWake,
    at: number,
    connectorEnabled: boolean,
  ): string | undefined {
    const wake = this.opts.config.wake
    if (!connectorEnabled) return 'connector-disabled'
    if (!wake.enabled) return 'wake-disabled'
    if (withinQuietHours(at, this.opts.proactive)) return 'quiet-hours'
    if (!wake.services.includes(pending.service)) return 'service-disabled'
    const denied = admissionDenial(pending.trigger, this.opts.admission)
    if (denied) return denied
    if (
      state.lastWakeAt !== undefined
      && at - state.lastWakeAt < wake.minIntervalMinutes * 60_000
    ) return 'min-interval'
    const today = dayKey(at, this.opts.proactive.timezone)
    const todayWakes = state.wakes.filter(row => dayKey(row.at, this.opts.proactive.timezone) === today)
    if (todayWakes.length >= wake.maxPerDay) return 'daily-cap'
    const currentTarget = this.findWakeTarget(wake)
    if (!currentTarget) return 'no-current-private-target'
    return sameWakeTarget(currentTarget, pending.trigger) ? undefined : 'private-target-changed'
  }

  private retireStaleTargetPending(
    state: ConnectorWakeState,
    pending: ConnectorPendingWake,
    at: number,
    reason: string,
  ): ConnectorWakeState {
    const next: ConnectorWakeState = {
      ...state,
      pending: (state.pending ?? []).filter(row => row.trigger.id !== pending.trigger.id),
      // Do not reconsider this source revision under a later target. It was
      // selected for a recipient whose authorization has since changed.
      notified: [...state.notified, { at, triggerId: pending.trigger.id }].slice(-MAX_NOTIFIED_ROWS),
    }
    this.saveState(next)
    this.log(`[connector] pending wake retired triggerId=${pending.trigger.id} reason=${reason}`)
    return next
  }

  private ingressComplete(triggerId: string): boolean {
    return Boolean(
      this.opts.store.getDoc<Trigger>('trigger', triggerId)
      && this.opts.store.getDoc<Disposition>('disposition', triggerId),
    )
  }

  private finishPending(state: ConnectorWakeState, pending: ConnectorPendingWake): ConnectorWakeState {
    const disposition = this.opts.store.getDoc<Disposition>('disposition', pending.trigger.id)
    const dispositionAt = typeof disposition?.at === 'string' ? Date.parse(disposition.at) : Number.NaN
    const completedAt = Number.isFinite(dispositionAt) ? dispositionAt : this.opts.now()
    const nonDelivery = disposition?.filtered !== undefined
    const next: ConnectorWakeState = {
      ...state,
      ...(!nonDelivery ? { lastWakeAt: completedAt } : {}),
      pending: (state.pending ?? []).filter(row => row.trigger.id !== pending.trigger.id),
      wakes: nonDelivery ? state.wakes : [...state.wakes, {
        at: completedAt,
        triggerId: pending.trigger.id,
        recordId: pending.recordId,
        service: pending.service,
      }].slice(-MAX_WAKE_ROWS),
      notified: [...state.notified, { at: completedAt, triggerId: pending.trigger.id }].slice(-MAX_NOTIFIED_ROWS),
    }
    this.saveState(next)
    if (nonDelivery) this.log(`[connector] pending ingress completed without delivery triggerId=${pending.trigger.id}`)
    return next
  }

  private loadState(): ConnectorWakeState {
    return loadConnectorWakeState(this.opts.store)
  }

  private saveState(state: ConnectorWakeState): void {
    this.opts.store.putDoc(CONNECTOR_WAKE_STATE_KIND, CONNECTOR_WAKE_STATE_ID, state)
  }
}

function sameWakeTarget(target: WakeTarget, trigger: Trigger): boolean {
  const channel = trigger.channel
  if (
    !channel
    || target.channel.source !== channel.source
    || target.channel.thread !== channel.thread
    || target.actor.source !== trigger.actor.source
    || target.actor.id !== trigger.actor.id
  ) return false
  const currentAddress = target.channel.address ?? {}
  const pendingAddress = channel.address ?? {}
  return ['provider', 'chat_id', 'chat_type', 'group', 'handle'].every(key =>
    currentAddress[key] === pendingAddress[key],
  )
}

/** Read the persisted wake window for CLI status and tests. */
export function loadConnectorWakeState(store: Store): ConnectorWakeState {
  const raw = store.getDoc<Partial<ConnectorWakeState>>(CONNECTOR_WAKE_STATE_KIND, CONNECTOR_WAKE_STATE_ID)
  if (!raw || typeof raw !== 'object') return { wakes: [], notified: [] }
  const wakes = Array.isArray(raw.wakes)
    ? raw.wakes.filter((row): row is ConnectorWakeRow =>
      row != null
      && typeof row === 'object'
      && typeof (row as ConnectorWakeRow).at === 'number'
      && Number.isFinite((row as ConnectorWakeRow).at)
      && typeof (row as ConnectorWakeRow).triggerId === 'string'
      && typeof (row as ConnectorWakeRow).recordId === 'string'
      && typeof (row as ConnectorWakeRow).service === 'string')
    : []
  const notified = Array.isArray(raw.notified)
    ? raw.notified.filter((row): row is ConnectorNotifiedRow =>
      row != null
      && typeof row === 'object'
      && typeof (row as ConnectorNotifiedRow).at === 'number'
      && Number.isFinite((row as ConnectorNotifiedRow).at)
      && typeof (row as ConnectorNotifiedRow).triggerId === 'string')
    : []
  const cursors: Partial<Record<GoogleService, string>> = {}
  if (raw.cursors && typeof raw.cursors === 'object' && !Array.isArray(raw.cursors)) {
    for (const [service, value] of Object.entries(raw.cursors)) {
      if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
        cursors[service as GoogleService] = value
      }
    }
  }
  const pageTokens: Partial<Record<GoogleService, string>> = {}
  if (raw.pageTokens && typeof raw.pageTokens === 'object' && !Array.isArray(raw.pageTokens)) {
    for (const [service, value] of Object.entries(raw.pageTokens)) {
      if (typeof value === 'string' && value.length > 0) pageTokens[service as GoogleService] = value
    }
  }
  const pageQueries: Partial<Record<GoogleService, { since: string; until: string }>> = {}
  if (raw.pageQueries && typeof raw.pageQueries === 'object' && !Array.isArray(raw.pageQueries)) {
    for (const [service, value] of Object.entries(raw.pageQueries)) {
      if (!value || typeof value !== 'object') continue
      const query = value as { since?: unknown; until?: unknown }
      if (
        typeof query.since === 'string' && Number.isFinite(Date.parse(query.since))
        && typeof query.until === 'string' && Number.isFinite(Date.parse(query.until))
      ) pageQueries[service as GoogleService] = { since: query.since, until: query.until }
    }
  }
  const invalidPageTokens: Partial<Record<GoogleService, string>> = {}
  if (raw.invalidPageTokens && typeof raw.invalidPageTokens === 'object' && !Array.isArray(raw.invalidPageTokens)) {
    for (const [service, value] of Object.entries(raw.invalidPageTokens)) {
      if (typeof value === 'string' && value.length > 0) invalidPageTokens[service as GoogleService] = value
    }
  }
  const invalidTokenRetries: Partial<Record<GoogleService, number>> = {}
  if (raw.invalidTokenRetries && typeof raw.invalidTokenRetries === 'object' && !Array.isArray(raw.invalidTokenRetries)) {
    for (const [service, value] of Object.entries(raw.invalidTokenRetries)) {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
        invalidTokenRetries[service as GoogleService] = value
      }
    }
  }
  const invalidTokenRetryAfter: Partial<Record<GoogleService, number>> = {}
  if (raw.invalidTokenRetryAfter && typeof raw.invalidTokenRetryAfter === 'object' && !Array.isArray(raw.invalidTokenRetryAfter)) {
    for (const [service, value] of Object.entries(raw.invalidTokenRetryAfter)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        invalidTokenRetryAfter[service as GoogleService] = value
      }
    }
  }
  const pending = Array.isArray(raw.pending)
    ? raw.pending.filter((row): row is ConnectorPendingWake => {
      if (!row || typeof row !== 'object') return false
      const candidate = row as ConnectorPendingWake
      return Number.isFinite(candidate.at)
        && typeof candidate.recordId === 'string'
        && typeof candidate.service === 'string'
        && candidate.trigger != null
        && typeof candidate.trigger.id === 'string'
    })
    : []
  return {
    ...(typeof raw.lastCheckAt === 'number' && Number.isFinite(raw.lastCheckAt)
      ? { lastCheckAt: raw.lastCheckAt }
      : {}),
    ...(typeof raw.lastWakeAt === 'number' && Number.isFinite(raw.lastWakeAt)
      ? { lastWakeAt: raw.lastWakeAt }
      : {}),
    ...(raw.backfillPending === true ? { backfillPending: true } : {}),
    ...(Object.keys(cursors).length ? { cursors } : {}),
    ...(Object.keys(pageTokens).length ? { pageTokens } : {}),
    ...(Object.keys(pageQueries).length ? { pageQueries } : {}),
    ...(Object.keys(invalidPageTokens).length ? { invalidPageTokens } : {}),
    ...(Object.keys(invalidTokenRetries).length ? { invalidTokenRetries } : {}),
    ...(Object.keys(invalidTokenRetryAfter).length ? { invalidTokenRetryAfter } : {}),
    ...(pending.length ? { pending } : {}),
    wakes,
    notified,
  }
}

function isPrivateTarget(
  channel: NonNullable<Trigger['channel']>,
  wake: ConnectorWakeConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  const address = channel.address ?? {}
  if (channel.source === 'cli') return wake.source === 'cli' && channel.thread === 'local'
  if (channel.source === 'imessage') return Boolean(address.handle) && !address.group
  if (channel.source === 'im') {
    if (address.provider === 'feishu') {
      const chatId = wake.chatId ?? env.FEISHU_CHAT_ID?.trim()
      return Boolean(chatId)
        && address.chat_id === chatId
        && address.chat_type === 'p2p'
    }
    return !address.group
  }
  return false
}

/**
 * The only Trigger a connector round may produce. It targets the exact private
 * thread that already admitted a human message; the recipient never changes.
 */
function connectorRevisionTriggerId(record: ConnectorRecord): string {
  return `${CONNECTOR_TRIGGER_PREFIX}${record.id}_${record.updatedAt}`
}

export function connectorTrigger(
  record: ConnectorRecord,
  target: WakeTarget,
  at: number,
): Trigger {
  const address: Record<string, string> = {}
  for (const [key, value] of Object.entries(target.channel.address ?? {})) {
    if (key === 'message_id' || key === 'root_id' || key === 'parent_id' || key === 'thread_id') continue
    address[key] = value
  }
  address[CONNECTOR_CHANNEL_MARKER] = '1'
  const fact = oneLine([record.title, record.text].filter(Boolean).join(' — '), 420)
  const text = [
    'CONNECTOR_EVENT',
    `service=${record.service}`,
    `kind=${record.kind}`,
    `recordId=${record.id}`,
    `reason=${record.wakeReason ?? 'provider-signal'}`,
    `occurredAt=${record.occurredAt}`,
    `fact=${fact}`,
    ...(record.url ? [`url=${record.url}`] : []),
    'instruction=Send at most one short message in this existing private thread, and only if this event needs the owner now.',
    'Use only the facts above; do not invent progress, people, or deadlines.',
    'Do not send an acknowledgement, a status line, a summary of these instructions, or a request for a reply.',
    'Do not mention connectors, polling, or that this was an automatic check.',
    'If the event is not genuinely useful, stay silent and stop this ticket.',
  ].join('\n')
  return {
    id: connectorRevisionTriggerId(record),
    source: target.channel.source,
    threads: [{ source: target.channel.source, id: target.channel.thread }],
    actor: { source: target.actor.source, id: target.actor.id },
    human: false,
    addressed: 'direct',
    at: new Date(at).toISOString(),
    text,
    channel: {
      source: target.channel.source,
      thread: target.channel.thread,
      address,
    },
    meta: {},
  }
}

/** A connector-only ticket is a messaging envelope: the Harness must never start a Worker. */
export function isConnectorWakeTicket(ticket: Ticket): boolean {
  return ticket.inputs.length === 1
    && ticket.inputs[0]?.triggerId === ticket.originTriggerId
    && ticket.channels.length > 0
    && ticket.channels.every(channel => channel.address?.[CONNECTOR_CHANNEL_MARKER] === '1')
}

function localTime(at: number, timezone: string): string {
  const offsets: Record<string, number> = { 'Asia/Shanghai': 8 * 60, UTC: 0 }
  const offset = offsets[timezone] ?? 0
  const date = new Date(at + offset * 60_000)
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

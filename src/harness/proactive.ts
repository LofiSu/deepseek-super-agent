import fs from 'node:fs'
import path from 'node:path'
import type { ChannelRef, Disposition, Ticket, Trigger } from '../shared/types.ts'
import { UserError } from '../shared/errors.ts'
import type { Store } from '../store/sqlite.ts'

/**
 * Built-in idle self-wake.
 *
 * This is owner-gated proactive contact over the normal ingress path, not a
 * second execution loop. The Daemon's existing pulse calls `tick()`; a due
 * round runs one deterministic policy pass over persisted state. Only when
 * that pass finds a concrete, useful fact does it hand one owner-authored
 * trigger to `Runtime.ingest`. The Router still decides whether to speak and
 * the existing Outbox performs the actual send.
 *
 * Defaults are deliberately safe: the feature is off unless `proactive.json`
 * says `"enabled": true`. The model has no tool that writes that file.
 */

export const PROACTIVE_FILE = 'proactive.json'
export const PROACTIVE_STATE_KIND = 'proactive'
export const PROACTIVE_STATE_ID = 'state'
export const PROACTIVE_TRIGGER_PREFIX = 'trg_proactive_'

export const DEFAULT_PROACTIVE_INTERVAL_MINUTES = 30
export const DEFAULT_PROACTIVE_MIN_INTERVAL_MINUTES = 180
export const DEFAULT_PROACTIVE_MAX_PER_DAY = 2
export const DEFAULT_PROACTIVE_ACTIVE_THREAD_MINUTES = 30
export const DEFAULT_PROACTIVE_QUIET_START = '23:00'
export const DEFAULT_PROACTIVE_QUIET_END = '08:00'
export const MAX_PROACTIVE_CONTACT_ROWS = 64
const CONTACT_RETENTION_MS = 7 * 86_400_000
const MIN_INTERVAL_MINUTES = 15
const MAX_INTERVAL_MINUTES = 1_440
const MAX_ACTIVE_THREAD_MINUTES = 1_440
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/
/** Fixed offsets only. This batch does not carry a timezone database. */
const TIMEZONES: Readonly<Record<string, number>> = {
  'Asia/Shanghai': 8 * 60,
  UTC: 0,
}
const CONFIG_KEYS = new Set([
  'enabled',
  'intervalMinutes',
  'timezone',
  'quietStart',
  'quietEnd',
  'minIntervalMinutes',
  'maxPerDay',
  'activeThreadCooldownMinutes',
  'thread',
  'chatId',
])

export interface ProactiveConfig {
  /** Off by default: the owner must opt in in `proactive.json`. */
  enabled: boolean
  /** How often the idle wake may evaluate. Default 30 minutes. */
  intervalMinutes: number
  /** `Asia/Shanghai` (default) or `UTC`; quiet hours use this zone. */
  timezone: string
  quietStart: string
  quietEnd: string
  minIntervalMinutes: number
  maxPerDay: number
  /** Do not interrupt a thread the owner used within this window. */
  activeThreadCooldownMinutes: number
  /** Optional private thread id. Never a new recipient. */
  thread?: string
  /** Optional Feishu chat id considered the owner's private chat. */
  chatId?: string
}

export const DEFAULT_PROACTIVE_CONFIG: Readonly<ProactiveConfig> = {
  enabled: false,
  intervalMinutes: DEFAULT_PROACTIVE_INTERVAL_MINUTES,
  timezone: 'Asia/Shanghai',
  quietStart: DEFAULT_PROACTIVE_QUIET_START,
  quietEnd: DEFAULT_PROACTIVE_QUIET_END,
  minIntervalMinutes: DEFAULT_PROACTIVE_MIN_INTERVAL_MINUTES,
  maxPerDay: DEFAULT_PROACTIVE_MAX_PER_DAY,
  activeThreadCooldownMinutes: DEFAULT_PROACTIVE_ACTIVE_THREAD_MINUTES,
}

export interface ProactiveContact {
  at: number
  triggerId: string
  ticketId: string
  thread: string
}

export interface ProactiveState {
  lastCheckAt?: number
  lastContactAt?: number
  contacts: ProactiveContact[]
}

export interface ProactivePlan {
  ticket: Ticket
  reason: 'report-question' | 'pending-approval' | 'report-blocked'
  fact: string
  thread: string
  channel: ChannelRef
  actor: string
  memory?: string
}

export type ProactiveTickAction =
  | 'disabled'
  | 'armed'
  | 'not-due'
  | 'clock-backwards'
  | 'quiet-hours'
  | 'min-interval'
  | 'daily-cap'
  | 'silent'
  | 'contact'

export interface ProactiveTickResult {
  action: ProactiveTickAction
  plan?: ProactivePlan
  trigger?: Trigger
}

export interface ProactiveSchedulerOptions {
  now: () => number
  store: Store
  config: ProactiveConfig
  env?: NodeJS.ProcessEnv
  /** Related memory, already scoped to the candidate ticket by the caller. */
  memoryFor?: (ticket: Ticket) => string[]
  /** Must be the Runtime ingress path, not a direct channel send. */
  fire: (trigger: Trigger) => void
  log?: (line: string) => void
}

interface RecentTrigger {
  id: string
  at: number
  source: string
  thread: string
  actor: string
  channel: ChannelRef
}

interface Signal {
  reason: ProactivePlan['reason']
  fact: string
  at: number
}

/**
 * Read the owner's config. A missing or blank file means "off" with the
 * documented defaults. A malformed file fails loudly: silent proactive contact
 * is safer than an accidental typo that turns it into a live or off schedule.
 */
export function loadProactiveConfig(home: string): ProactiveConfig {
  const file = path.join(home, PROACTIVE_FILE)
  let content: string | undefined
  try {
    content = fs.readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw new UserError(`${PROACTIVE_FILE} could not be read: ${messageOf(error)}`)
    }
  }
  if (content === undefined || !content.trim()) return normalizeProactiveConfig({})
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch (error) {
    throw new UserError(`${PROACTIVE_FILE} is not valid JSON: ${messageOf(error)}`)
  }
  return normalizeProactiveConfig(raw)
}

export function normalizeProactiveConfig(raw: unknown): ProactiveConfig {
  if (raw == null) return normalizeProactiveConfig({})
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UserError(`${PROACTIVE_FILE} must be a JSON object`)
  }
  const value = raw as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new UserError(`${PROACTIVE_FILE} has unknown key ${key}`)
  }
  const enabled = value.enabled === undefined ? false : value.enabled
  if (typeof enabled !== 'boolean') throw new UserError(`${PROACTIVE_FILE} enabled must be a boolean`)

  const intervalMinutes = integer(value.intervalMinutes, 'intervalMinutes', 5, MAX_INTERVAL_MINUTES, DEFAULT_PROACTIVE_INTERVAL_MINUTES)
  const minIntervalMinutes = integer(
    value.minIntervalMinutes,
    'minIntervalMinutes',
    MIN_INTERVAL_MINUTES,
    10_080,
    DEFAULT_PROACTIVE_MIN_INTERVAL_MINUTES,
  )
  const maxPerDay = integer(value.maxPerDay, 'maxPerDay', 0, 24, DEFAULT_PROACTIVE_MAX_PER_DAY)
  const activeThreadCooldownMinutes = integer(
    value.activeThreadCooldownMinutes,
    'activeThreadCooldownMinutes',
    0,
    MAX_ACTIVE_THREAD_MINUTES,
    DEFAULT_PROACTIVE_ACTIVE_THREAD_MINUTES,
  )

  const timezone = value.timezone === undefined ? 'Asia/Shanghai' : value.timezone
  if (typeof timezone !== 'string' || !(timezone in TIMEZONES)) {
    throw new UserError(`${PROACTIVE_FILE} timezone must be Asia/Shanghai or UTC in this batch`)
  }
  const quietStart = time(value.quietStart, 'quietStart', DEFAULT_PROACTIVE_QUIET_START)
  const quietEnd = time(value.quietEnd, 'quietEnd', DEFAULT_PROACTIVE_QUIET_END)
  const thread = oneLine(value.thread, 'thread')
  const chatId = oneLine(value.chatId, 'chatId')
  return {
    enabled,
    intervalMinutes,
    timezone,
    quietStart,
    quietEnd,
    minIntervalMinutes,
    maxPerDay,
    activeThreadCooldownMinutes,
    ...(thread ? { thread } : {}),
    ...(chatId ? { chatId } : {}),
  }
}

function integer(
  raw: unknown,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new UserError(`${PROACTIVE_FILE} ${name} must be an integer between ${min} and ${max}`)
  }
  return raw
}

function time(raw: unknown, name: string, fallback: string): string {
  if (raw === undefined) return fallback
  if (typeof raw !== 'string' || !TIME.test(raw)) {
    throw new UserError(`${PROACTIVE_FILE} ${name} must be HH:MM`)
  }
  return raw
}

function oneLine(raw: unknown, name: string): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || !raw.trim() || /[\r\n\0]/.test(raw)) {
    throw new UserError(`${PROACTIVE_FILE} ${name} must be one non-empty line`)
  }
  return raw.trim()
}

/**
 * Due-checking over persisted state. Like `RoutineScheduler`, it owns no timer:
 * the Daemon pulse drives it. The first tick only arms. A restart after a long
 * gap produces one evaluation at the latest due round, never a burst.
 */
export class ProactiveScheduler {
  private readonly memoryFor: (ticket: Ticket) => string[]
  private readonly log: (line: string) => void

  constructor(private readonly opts: ProactiveSchedulerOptions) {
    this.memoryFor = opts.memoryFor ?? (() => [])
    this.log = opts.log ?? (() => undefined)
  }

  get config(): ProactiveConfig {
    return this.opts.config
  }

  state(): ProactiveState {
    return this.loadState()
  }

  tick(at = this.opts.now()): ProactiveTickResult {
    const config = this.opts.config
    if (!config.enabled) return { action: 'disabled' }
    const state = this.loadState()

    if (state.lastCheckAt === undefined) {
      this.saveState({ ...state, lastCheckAt: at })
      this.log(`[proactive] armed intervalMinutes=${config.intervalMinutes} tz=${config.timezone}`)
      return { action: 'armed' }
    }
    if (typeof state.lastCheckAt !== 'number' || !Number.isFinite(state.lastCheckAt)) {
      this.saveState({ ...state, lastCheckAt: at })
      this.log('[proactive] invalid lastCheckAt; re-armed')
      return { action: 'armed' }
    }
    if (at < state.lastCheckAt) {
      const interval = config.intervalMinutes * 60_000
      if (state.lastCheckAt - at > Math.max(2 * interval, 10 * 60_000)) {
        this.saveState({ ...state, lastCheckAt: at })
        this.log(`[proactive] clock moved backwards by=${state.lastCheckAt - at}ms; re-armed`)
        return { action: 'clock-backwards' }
      }
      this.log('[proactive] clock moved backwards; skipping')
      return { action: 'not-due' }
    }
    if (at - state.lastCheckAt < config.intervalMinutes * 60_000) return { action: 'not-due' }

    // One due round only. Persist the check before any contact so a crash
    // cannot replay every missed interval, and the stable trigger id makes a
    // retry an ingress duplicate instead of a second message.
    const checked: ProactiveState = { ...state, lastCheckAt: at }
    if (this.inQuietHours(at)) {
      this.saveState(checked)
      this.log(`[proactive] quiet-hours now=${localTime(at, config.timezone)}`)
      return { action: 'quiet-hours' }
    }
    if (state.lastContactAt !== undefined && at - state.lastContactAt < config.minIntervalMinutes * 60_000) {
      this.saveState(checked)
      this.log(`[proactive] min-interval lastContactAt=${new Date(state.lastContactAt).toISOString()}`)
      return { action: 'min-interval' }
    }
    const today = dayKey(at, config.timezone)
    const contactsToday = state.contacts.filter(contact => dayKey(contact.at, config.timezone) === today)
    if (contactsToday.length >= config.maxPerDay) {
      this.saveState(checked)
      this.log(`[proactive] daily-cap count=${contactsToday.length} max=${config.maxPerDay}`)
      return { action: 'daily-cap' }
    }

    let plan: ProactivePlan | undefined
    try {
      plan = planProactiveContact({
        now: at,
        store: this.opts.store,
        config,
        env: this.opts.env ?? process.env,
        memoryFor: this.memoryFor,
      })
    } catch (error) {
      // A malformed ticket or memory row must not kill the serving daemon.
      this.saveState(checked)
      this.log(`[proactive] plan failed: ${messageOf(error)}`)
      return { action: 'silent' }
    }
    if (!plan) {
      this.saveState(checked)
      this.log('[proactive] silent reason=no-useful-signal')
      return { action: 'silent' }
    }

    const trigger = proactiveTrigger(plan, at, config.timezone)
    const contacts = [...state.contacts, {
      at,
      triggerId: trigger.id,
      ticketId: plan.ticket.id,
      thread: plan.thread,
    }]
      .filter(contact => at - contact.at <= CONTACT_RETENTION_MS)
      .slice(-MAX_PROACTIVE_CONTACT_ROWS)
    // Record before fire: a failed/partly failed wake must consume the quota,
    // not leave a window for an immediate retry burst. The stable trigger id
    // also deduplicates a crash between this write and persistence.
    this.saveState({ ...checked, lastContactAt: at, contacts })
    try {
      this.opts.fire(trigger)
    } catch (error) {
      this.log(`[proactive] fire failed ticketId=${plan.ticket.id}: ${messageOf(error)}`)
      return { action: 'contact', plan, trigger }
    }
    this.log(
      `[proactive] fired ticketId=${plan.ticket.id} reason=${plan.reason} thread=${plan.thread} triggerId=${trigger.id}`,
    )
    return { action: 'contact', plan, trigger }
  }

  private inQuietHours(at: number): boolean {
    const config = this.opts.config
    const start = parseMinutes(config.quietStart)
    const end = parseMinutes(config.quietEnd)
    if (start === end) return false
    const now = localMinutes(at, config.timezone)
    return start < end
      ? now >= start && now < end
      : now >= start || now < end
  }

  private loadState(): ProactiveState {
    const raw = this.opts.store.getDoc<Partial<ProactiveState>>(PROACTIVE_STATE_KIND, PROACTIVE_STATE_ID)
    if (!raw || typeof raw !== 'object') return { contacts: [] }
    const contacts = Array.isArray(raw.contacts)
      ? raw.contacts.filter((contact): contact is ProactiveContact =>
        contact != null
        && typeof contact === 'object'
        && typeof (contact as ProactiveContact).at === 'number'
        && Number.isFinite((contact as ProactiveContact).at)
        && typeof (contact as ProactiveContact).triggerId === 'string'
        && typeof (contact as ProactiveContact).ticketId === 'string'
        && typeof (contact as ProactiveContact).thread === 'string')
      : []
    return {
      ...(typeof raw.lastCheckAt === 'number' && Number.isFinite(raw.lastCheckAt)
        ? { lastCheckAt: raw.lastCheckAt }
        : {}),
      ...(typeof raw.lastContactAt === 'number' && Number.isFinite(raw.lastContactAt)
        ? { lastContactAt: raw.lastContactAt }
        : {}),
      contacts,
    }
  }

  private saveState(state: ProactiveState): void {
    this.opts.store.putDoc(PROACTIVE_STATE_KIND, PROACTIVE_STATE_ID, state)
  }
}

/**
 * Deterministic policy pass over recent real sessions, unfinished tickets, and
 * memory. It returns at most one concrete fact. An open ticket alone is not a
 * reason: there must be a new question, a pending owner decision, or a newly
 * blocked/failed state. Silence is the default.
 */
export function planProactiveContact(input: {
  now: number
  store: Store
  config: ProactiveConfig
  env: NodeJS.ProcessEnv
  memoryFor?: (ticket: Ticket) => string[]
}): ProactivePlan | undefined {
  const recent = recentRealTriggers(input.store)
  if (!recent.length) return undefined
  const candidates: { ticket: Ticket; signal: Signal }[] = []
  for (const ticket of input.store.listDocs<Ticket>('ticket')) {
    if (ticket.ended != null) continue
    const signal = signalOf(ticket)
    if (signal) candidates.push({ ticket, signal })
  }
  candidates.sort((left, right) =>
    right.signal.at - left.signal.at
    || right.ticket.createdAt.localeCompare(left.ticket.createdAt))

  for (const { ticket, signal } of candidates) {
    const channel = privateChannelFor(ticket, recent, input.config, input.env)
    if (!channel) continue
    const thread = channel.thread
    // Do not interrupt a conversation the owner is already having.
    const latestOwnerMessage = recent
      .filter(item => item.thread === thread && item.source === channel.source)
      .at(-1)
    if (
      latestOwnerMessage
      && input.now - latestOwnerMessage.at < input.config.activeThreadCooldownMinutes * 60_000
    ) {
      continue
    }
    const owner = recent
      .filter(item => item.thread === thread && item.source === channel.source)
      .at(-1)
    if (!owner) continue
    let memory: string | undefined
    try {
      memory = (input.memoryFor?.(ticket) ?? [])
        .map(text => oneLineText(text))
        .find(text => text.length > 0 && sharesToken(text, `${ticket.title} ${signal.fact}`))
    } catch {
      // Memory is context, never a reason to contact or crash.
    }
    return {
      ticket,
      reason: signal.reason,
      fact: signal.fact,
      thread,
      channel,
      actor: owner.actor,
      ...(memory ? { memory } : {}),
    }
  }
  return undefined
}

function signalOf(ticket: Ticket): Signal | undefined {
  const assignment = [...ticket.assignments].reverse().find(item => item.report)
  const report = assignment?.report
  const reportedAt = Date.parse(report?.at ?? assignment?.endedAt ?? assignment?.startedAt ?? ticket.createdAt)
  const base = Number.isFinite(reportedAt) ? reportedAt : Date.parse(ticket.createdAt)
  const question = typeof report?.question === 'string' ? oneLineText(report.question) : ''
  if (question) {
    return {
      reason: 'report-question',
      fact: `「${shortTitle(ticket.title)}」那边有个问题：${truncate(question, 180)}`,
      at: base,
    }
  }
  const approval = [...(ticket.collab?.approvals ?? [])]
    .filter(item => item.status === 'pending')
    .at(-1)
  if (approval) {
    const approvedAt = Date.parse(approval.at)
    return {
      reason: 'pending-approval',
      fact: `「${shortTitle(ticket.title)}」有一个操作等你确认：${truncate(oneLineText(approval.action), 160)}`,
      at: Number.isFinite(approvedAt) ? approvedAt : base,
    }
  }
  if (
    report
    && (report.kind === 'blocked' || report.kind === 'waiting' || report.kind === 'failed')
    && typeof report.text === 'string'
    && oneLineText(report.text)
  ) {
    return {
      reason: 'report-blocked',
      fact: `「${shortTitle(ticket.title)}」现在卡在：${truncate(oneLineText(report.text), 180)}`,
      at: base,
    }
  }
  return undefined
}

function recentRealTriggers(store: Store): RecentTrigger[] {
  const items: RecentTrigger[] = []
  for (const trigger of store.listDocs<Trigger>('trigger')) {
    if (trigger.human !== true) continue
    if (trigger.id.startsWith(PROACTIVE_TRIGGER_PREFIX)) continue
    const disposition = store.getDoc<Disposition>('disposition', trigger.id)
    if (!disposition || disposition.filtered !== undefined) continue
    const channel = trigger.channel
    if (!channel || !channel.thread) continue
    const at = Date.parse(trigger.at)
    if (!Number.isFinite(at)) continue
    items.push({
      id: trigger.id,
      at,
      source: channel.source,
      thread: channel.thread,
      actor: trigger.actor.id,
      channel,
    })
  }
  items.sort((left, right) => left.at - right.at)
  // Recent real human messages prove the thread exists and was admitted.
  return items.slice(-40)
}

/**
 * A candidate may only reuse a thread that already carried an admitted human
 * message and is private. This is the "never a new recipient / never a group"
 * boundary; the Router and Outbox then have only that thread to reply into.
 */
function privateChannelFor(
  ticket: Ticket,
  recent: readonly RecentTrigger[],
  config: ProactiveConfig,
  env: NodeJS.ProcessEnv,
): ChannelRef | undefined {
  const allowed = new Set(recent.map(item => `${item.source}:${item.thread}`))
  for (const channel of ticket.channels) {
    const key = `${channel.source}:${channel.thread}`
    if (!allowed.has(key)) continue
    if (config.thread && channel.thread !== config.thread) continue
    if (!isPrivate(channel, config, env)) continue
    return channel
  }
  return undefined
}

function isPrivate(channel: ChannelRef, config: ProactiveConfig, env: NodeJS.ProcessEnv): boolean {
  const address = channel.address ?? {}
  if (channel.source === 'imessage') {
    return Boolean(address.handle) && !address.group
  }
  if (channel.source === 'im') {
    if (address.provider === 'feishu') {
      const chatId = config.chatId ?? env.FEISHU_CHAT_ID?.trim()
      return Boolean(chatId) && address.chat_id === chatId
    }
    // A generic IM adapter marks a group explicitly. No group means 1:1.
    return !address.group
  }
  return false
}

/** The owner-authored trigger one due round produces. Stable id, one thread. */
export function proactiveTrigger(plan: ProactivePlan, at: number, timezone = 'Asia/Shanghai'): Trigger {
  const address: Record<string, string> = {}
  for (const [key, value] of Object.entries(plan.channel.address ?? {})) {
    // A stale message id would make the Outbox reply to an old message. Send
    // to the same chat instead; the recipient never changes.
    if (key === 'message_id' || key === 'root_id' || key === 'parent_id' || key === 'thread_id') continue
    address[key] = value
  }
  address.proactive = '1'
  const text = [
    'PROACTIVE_IDLE',
    `ticketId=${plan.ticket.id}`,
    `reason=${plan.reason}`,
    `fact=${plan.fact}`,
    ...(plan.memory ? [`relatedMemory=${plan.memory}`] : []),
    'instruction=Send at most one short message in this existing private thread.',
    'Use only the fact above; do not invent progress. Do not list other tickets.',
    'Do not ask for a reply or mention that this was a scheduled check.',
    'If the fact is not genuinely useful, stay silent and stop this ticket.',
  ].join('\n')
  return {
    id: `${PROACTIVE_TRIGGER_PREFIX}${safeId(plan.ticket.id)}_${dayKey(at, timezone)}_${plan.reason}`,
    source: plan.channel.source,
    threads: [{ source: plan.channel.source, id: plan.thread }],
    actor: { source: plan.channel.source, id: plan.actor },
    human: true,
    addressed: 'direct',
    at: new Date(at).toISOString(),
    text,
    channel: {
      source: plan.channel.source,
      thread: plan.thread,
      address,
    },
    meta: {},
  }
}

/** A proactive ticket is a messaging envelope: the Harness must never start a Worker for it. */
export function isProactiveTicket(ticket: Ticket): boolean {
  return ticket.channels.some(channel => channel.address?.proactive === '1')
}

export function dayKey(at: number, timezone: string): string {
  const offset = TIMEZONES[timezone] ?? 0
  return new Date(at + offset * 60_000).toISOString().slice(0, 10)
}

function localMinutes(at: number, timezone: string): number {
  const offset = TIMEZONES[timezone] ?? 0
  const date = new Date(at + offset * 60_000)
  return date.getUTCHours() * 60 + date.getUTCMinutes()
}

function localTime(at: number, timezone: string): string {
  const offset = TIMEZONES[timezone] ?? 0
  const date = new Date(at + offset * 60_000)
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
}

function parseMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number) as [number, number]
  return hours * 60 + minutes
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
}

function shortTitle(value: string): string {
  return truncate(oneLineText(value), 60)
}

function oneLineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function sharesToken(left: string, right: string): boolean {
  const tokens = new Set(left.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(token => token.length >= 2))
  if (right.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).some(token => token.length >= 2 && tokens.has(token))) {
    return true
  }
  // Chinese prose has no spaces, so a short memory token ("附件") rarely equals
  // a fact token ("核对附件"). A contained CJK token is the useful signal.
  return [...tokens].some(token => /[㐀-鿿]/u.test(token) && right.includes(token))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

import fs from 'node:fs'
import path from 'node:path'
import { UserError } from '../shared/errors.ts'
import { GOOGLE_SERVICES, isGoogleService, type GoogleService } from './types.ts'

/**
 * Owner-gated Google Workspace connector configuration.
 *
 * `connectors.json` in the agent home is the only switch. A missing or blank
 * file means the whole feature is off, and credentials are not even read. An
 * enabled configuration must name one credential source; a malformed file or
 * missing credentials fails at startup instead of becoming a silent schedule.
 *
 * The model has no tool that writes this file.
 */

export const CONNECTORS_FILE = 'connectors.json'
export const DEFAULT_GOOGLE_CREDENTIALS_ENV = 'GOOGLE_WORKSPACE_CREDENTIALS'
export const CONNECTOR_MAX_RECORDS_DEFAULT = 5_000
export const CONNECTOR_MAX_AGE_DAYS_DEFAULT = 180
export const CONNECTOR_POLL_MINUTES_DEFAULT = 15
export const CONNECTOR_MAX_RECORDS_PER_POLL_DEFAULT = 25

export const CONNECTOR_WAKE_SOURCES = ['cli', 'im', 'imessage'] as const
export type ConnectorWakeSource = (typeof CONNECTOR_WAKE_SOURCES)[number]

export interface GoogleConnectorConfig {
  /** Read scopes this process may poll. All seven are supported. */
  services: GoogleService[]
  /** Environment variable holding the OAuth credential JSON. */
  credentialsEnv?: string
  /** Owner-readable file holding the same JSON. Relative paths use `home`. */
  credentialsFile?: string
}

export interface ConnectorPollConfig {
  /** Minimum minutes between polls. First poll only arms/backfills. */
  intervalMinutes: number
  /** Provider records requested per service per poll. */
  maxRecordsPerPoll: number
}

export interface ConnectorIndexConfig {
  /** 0 disables the count bound. */
  maxRecords: number
  /** 0 disables the age bound. */
  maxAgeDays: number
}

export interface ConnectorWakeConfig {
  enabled: boolean
  /** Services whose records may wake the owner. */
  services: GoogleService[]
  /** Existing admitted private thread to reuse. Never a new recipient. */
  source: ConnectorWakeSource
  thread: string
  /** Feishu owner chat id; also read from `FEISHU_CHAT_ID`. */
  chatId?: string
  minIntervalMinutes: number
  maxPerDay: number
  /** How far back the first backfill or a fresh service looks. */
  lookbackMinutes: number
  /** Current admission lookahead for imminent Calendar events and due Tasks. */
  calendarLookaheadMinutes: number
}

export interface ConnectorConfig {
  enabled: boolean
  google: GoogleConnectorConfig
  poll: ConnectorPollConfig
  index: ConnectorIndexConfig
  wake: ConnectorWakeConfig
}

export const DEFAULT_CONNECTOR_CONFIG: Readonly<ConnectorConfig> = {
  enabled: false,
  google: { services: [...GOOGLE_SERVICES] },
  poll: {
    intervalMinutes: CONNECTOR_POLL_MINUTES_DEFAULT,
    maxRecordsPerPoll: CONNECTOR_MAX_RECORDS_PER_POLL_DEFAULT,
  },
  index: {
    maxRecords: CONNECTOR_MAX_RECORDS_DEFAULT,
    maxAgeDays: CONNECTOR_MAX_AGE_DAYS_DEFAULT,
  },
  wake: {
    enabled: false,
    services: ['gmail', 'calendar'],
    source: 'cli',
    thread: 'local',
    minIntervalMinutes: 120,
    maxPerDay: 3,
    lookbackMinutes: 120,
    calendarLookaheadMinutes: 120,
  },
}

export interface GoogleCredentials {
  clientId: string
  clientSecret: string
  refreshToken: string
}

const TOP_KEYS = new Set(['enabled', 'google', 'poll', 'index', 'wake'])
const GOOGLE_KEYS = new Set(['services', 'credentialsEnv', 'credentialsFile'])
const POLL_KEYS = new Set(['intervalMinutes', 'maxRecordsPerPoll'])
const INDEX_KEYS = new Set(['maxRecords', 'maxAgeDays'])
const WAKE_KEYS = new Set([
  'enabled',
  'services',
  'source',
  'thread',
  'chatId',
  'minIntervalMinutes',
  'maxPerDay',
  'lookbackMinutes',
  'calendarLookaheadMinutes',
])
const CREDENTIAL_KEYS = new Set(['clientId', 'clientSecret', 'refreshToken'])
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function missingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read `connectors.json`. Missing or blank means off with safe defaults. A
 * malformed file fails loudly; an operator should never have to guess whether
 * a typo disabled the schedule or turned it live.
 */
export function loadConnectorConfig(
  home: string,
  _env: Readonly<Record<string, string | undefined>> = process.env,
): ConnectorConfig {
  const file = path.join(home, CONNECTORS_FILE)
  let content: string | undefined
  try {
    content = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (!missingFile(error)) {
      throw new UserError(`${CONNECTORS_FILE} could not be read: ${messageOf(error)}`)
    }
  }
  if (content === undefined || !content.trim()) return normalizeConnectorConfig({})
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch (error) {
    throw new UserError(`${CONNECTORS_FILE} is not valid JSON: ${messageOf(error)}`)
  }
  return normalizeConnectorConfig(raw)
}

export function normalizeConnectorConfig(raw: unknown): ConnectorConfig {
  if (raw == null) return normalizeConnectorConfig({})
  const value = object(raw, CONNECTORS_FILE)
  rejectUnknown(value, TOP_KEYS, CONNECTORS_FILE)

  const enabled = bool(value.enabled, 'enabled', false)
  const google = googleConfig(value.google)
  const poll = pollConfig(value.poll)
  const index = indexConfig(value.index)
  const wake = wakeConfig(value.wake, google.services)

  if (wake.enabled && !enabled) {
    throw new UserError(`${CONNECTORS_FILE} wake.enabled requires the top-level enabled to be true`)
  }
  return { enabled, google, poll, index, wake }
}

function googleConfig(raw: unknown): GoogleConnectorConfig {
  if (raw === undefined) return { services: [...GOOGLE_SERVICES] }
  const value = object(raw, `${CONNECTORS_FILE} google`)
  rejectUnknown(value, GOOGLE_KEYS, `${CONNECTORS_FILE} google`)
  const services = serviceList(value.services, 'google.services', [...GOOGLE_SERVICES])
  const credentialsEnv = optionalLine(value.credentialsEnv, 'google.credentialsEnv')
  if (credentialsEnv !== undefined && !ENV_NAME.test(credentialsEnv)) {
    throw new UserError(`${CONNECTORS_FILE} google.credentialsEnv must be an environment variable name`)
  }
  const credentialsFile = optionalLine(value.credentialsFile, 'google.credentialsFile')
  if (credentialsEnv !== undefined && credentialsFile !== undefined) {
    throw new UserError(`${CONNECTORS_FILE} google must name exactly one of credentialsEnv or credentialsFile`)
  }
  return {
    services,
    ...(credentialsEnv !== undefined
      ? { credentialsEnv }
      : credentialsFile === undefined
        ? { credentialsEnv: DEFAULT_GOOGLE_CREDENTIALS_ENV }
        : {}),
    ...(credentialsFile !== undefined ? { credentialsFile } : {}),
  }
}

function serviceList(
  raw: unknown,
  field: string,
  fallback: GoogleService[],
): GoogleService[] {
  if (raw === undefined) return fallback
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new UserError(`${CONNECTORS_FILE} ${field} must be a non-empty array`)
  }
  const services: GoogleService[] = []
  for (const item of raw) {
    if (!isGoogleService(item)) {
      throw new UserError(`${CONNECTORS_FILE} ${field} contains an unsupported service`)
    }
    if (services.includes(item)) throw new UserError(`${CONNECTORS_FILE} ${field} has a duplicate`)
    services.push(item)
  }
  return services
}

function pollConfig(raw: unknown): ConnectorPollConfig {
  if (raw === undefined) return { ...DEFAULT_CONNECTOR_CONFIG.poll }
  const value = object(raw, `${CONNECTORS_FILE} poll`)
  rejectUnknown(value, POLL_KEYS, `${CONNECTORS_FILE} poll`)
  return {
    intervalMinutes: integer(value.intervalMinutes, 'poll.intervalMinutes', 5, 1_440, CONNECTOR_POLL_MINUTES_DEFAULT),
    maxRecordsPerPoll: integer(
      value.maxRecordsPerPoll,
      'poll.maxRecordsPerPoll',
      1,
      100,
      CONNECTOR_MAX_RECORDS_PER_POLL_DEFAULT,
    ),
  }
}

function indexConfig(raw: unknown): ConnectorIndexConfig {
  if (raw === undefined) return { ...DEFAULT_CONNECTOR_CONFIG.index }
  const value = object(raw, `${CONNECTORS_FILE} index`)
  rejectUnknown(value, INDEX_KEYS, `${CONNECTORS_FILE} index`)
  return {
    maxRecords: integer(value.maxRecords, 'index.maxRecords', 0, 1_000_000, CONNECTOR_MAX_RECORDS_DEFAULT),
    maxAgeDays: integer(value.maxAgeDays, 'index.maxAgeDays', 0, 3_650, CONNECTOR_MAX_AGE_DAYS_DEFAULT),
  }
}

function wakeConfig(raw: unknown, googleServices: GoogleService[]): ConnectorWakeConfig {
  if (raw === undefined) {
    return {
      ...DEFAULT_CONNECTOR_CONFIG.wake,
      services: [...DEFAULT_CONNECTOR_CONFIG.wake.services],
    }
  }
  const value = object(raw, `${CONNECTORS_FILE} wake`)
  rejectUnknown(value, WAKE_KEYS, `${CONNECTORS_FILE} wake`)
  const services = serviceList(value.services, 'wake.services', [...DEFAULT_CONNECTOR_CONFIG.wake.services])
  for (const service of services) {
    if (!googleServices.includes(service)) {
      throw new UserError(`${CONNECTORS_FILE} wake.services must be a subset of google.services`)
    }
  }
  const source = value.source === undefined ? DEFAULT_CONNECTOR_CONFIG.wake.source : value.source
  if (typeof source !== 'string' || !(CONNECTOR_WAKE_SOURCES as readonly string[]).includes(source)) {
    throw new UserError(`${CONNECTORS_FILE} wake.source must be one of ${CONNECTOR_WAKE_SOURCES.join(', ')}`)
  }
  return {
    enabled: bool(value.enabled, 'wake.enabled', false),
    services,
    source: source as ConnectorWakeSource,
    thread: oneLine(value.thread, 'wake.thread', DEFAULT_CONNECTOR_CONFIG.wake.thread),
    ...(value.chatId === undefined ? {} : { chatId: oneLine(value.chatId, 'wake.chatId', '') }),
    minIntervalMinutes: integer(
      value.minIntervalMinutes,
      'wake.minIntervalMinutes',
      15,
      10_080,
      DEFAULT_CONNECTOR_CONFIG.wake.minIntervalMinutes,
    ),
    maxPerDay: integer(value.maxPerDay, 'wake.maxPerDay', 0, 24, DEFAULT_CONNECTOR_CONFIG.wake.maxPerDay),
    lookbackMinutes: integer(
      value.lookbackMinutes,
      'wake.lookbackMinutes',
      5,
      10_080,
      DEFAULT_CONNECTOR_CONFIG.wake.lookbackMinutes,
    ),
    calendarLookaheadMinutes: integer(
      value.calendarLookaheadMinutes,
      'wake.calendarLookaheadMinutes',
      5,
      1_440,
      DEFAULT_CONNECTOR_CONFIG.wake.calendarLookaheadMinutes,
    ),
  }
}

/**
 * Resolve OAuth credentials. Called only for an enabled connector. Missing or
 * malformed values throw: an owner who opted in should not get a silently dead
 * poller. The returned values never appear in a log line or error message.
 */
export function resolveGoogleCredentials(
  config: ConnectorConfig,
  home: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): GoogleCredentials | undefined {
  if (!config.enabled) return undefined
  const { credentialsEnv, credentialsFile } = config.google
  if (credentialsFile !== undefined) {
    const file = path.isAbsolute(credentialsFile)
      ? credentialsFile
      : path.join(home, credentialsFile)
    let content: string
    try {
      content = fs.readFileSync(file, 'utf8')
    } catch (error) {
      throw new UserError(
        `${CONNECTORS_FILE} google.credentialsFile could not be read: ${messageOf(error)}`,
      )
    }
    return parseGoogleCredentials(content, 'google.credentialsFile')
  }
  const name = credentialsEnv ?? DEFAULT_GOOGLE_CREDENTIALS_ENV
  const value = env[name]
  if (typeof value !== 'string' || !value.trim()) {
    throw new UserError(
      `${CONNECTORS_FILE} is enabled but ${name} is not set; `
      + 'add OAuth credentials or disable connectors',
    )
  }
  return parseGoogleCredentials(value, name)
}

export function parseGoogleCredentials(content: string, source: string): GoogleCredentials {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    // Parser diagnostics may quote the malformed input, which can contain OAuth secrets.
    throw new UserError(`${source} is not valid JSON`)
  }
  const value = object(raw, source)
  rejectUnknown(value, CREDENTIAL_KEYS, source, false)
  const clientId = requiredLine(value.clientId, source, 'clientId')
  const clientSecret = requiredLine(value.clientSecret, source, 'clientSecret')
  const refreshToken = requiredLine(value.refreshToken, source, 'refreshToken')
  return { clientId, clientSecret, refreshToken }
}

function object(raw: unknown, label: string): Record<string, unknown> {
  if (raw == null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UserError(`${label} must be a JSON object`)
  }
  return raw as Record<string, unknown>
}

function rejectUnknown(
  value: Record<string, unknown>,
  keys: Set<string>,
  label: string,
  revealKey = true,
): void {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      throw new UserError(revealKey ? `${label} has unknown key ${key}` : `${label} has an unknown key`)
    }
  }
}

function bool(raw: unknown, field: string, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  if (typeof raw !== 'boolean') throw new UserError(`${CONNECTORS_FILE} ${field} must be a boolean`)
  return raw
}

function integer(
  raw: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new UserError(`${CONNECTORS_FILE} ${field} must be an integer between ${min} and ${max}`)
  }
  return raw
}

function oneLine(raw: unknown, field: string, fallback: string): string {
  const value = optionalLine(raw, field)
  return value ?? fallback
}

function optionalLine(raw: unknown, field: string): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || !raw.trim() || /[\r\n\0]/.test(raw)) {
    throw new UserError(`${CONNECTORS_FILE} ${field} must be one non-empty line`)
  }
  return raw.trim()
}

function requiredLine(raw: unknown, source: string, field: string): string {
  if (typeof raw !== 'string' || !raw.trim() || /[\r\n\0]/.test(raw)) {
    throw new UserError(`${source} ${field} must be one non-empty string`)
  }
  return raw.trim()
}

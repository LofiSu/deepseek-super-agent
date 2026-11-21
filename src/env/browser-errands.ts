import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { UserError } from '../shared/errors.ts'
import { ENV_ALLOWLIST, redactKnownSecrets, secretValues } from './sanitize.ts'

/**
 * Owner-gated browser errands.
 *
 * This is ds-agent's own adapter, not Instinct's leased cloud browser. It calls
 * a driver the owner configured: a local executable or a remote HTTP endpoint.
 * Missing configuration means the tools are not registered at all; a malformed
 * configuration or a missing executable fails at startup instead of degrading
 * into an unknown state.
 *
 * The model never supplies a command, argv, environment, or driver URL. It can
 * only ask for one of the safe actions below inside a Worker ticket. Actions
 * that leave the page or change an account (`submit`, `purchase`, `send`,
 * `delete`, `change_account_settings`) are refused by the adapter and the
 * driver; they remain behind the existing owner approval hold.
 */

export const BROWSER_ERRANDS_FILE = 'browser-errands.json'
export const BROWSER_ERRANDS_ENV = 'DS_AGENT_BROWSER_ERRANDS'
export const BROWSER_PROTOCOL = 'ds-agent-browser-errand/v1'

export const BROWSER_ERRAND_ACTIONS = ['navigate', 'read', 'fill', 'extract'] as const
export type BrowserErrandAction = (typeof BROWSER_ERRAND_ACTIONS)[number]

/** Actions this adapter never performs. They need the owner, not a browser tool. */
export const IRREVERSIBLE_BROWSER_ACTIONS = [
  'submit',
  'purchase',
  'send',
  'delete',
  'change_account_settings',
] as const

export const DEFAULT_BROWSER_TIMEOUT_MS = 30_000
export const MIN_BROWSER_TIMEOUT_MS = 100
export const MAX_BROWSER_TIMEOUT_MS = 120_000
export const DEFAULT_BROWSER_READ_CHARS = 20_000
export const MAX_BROWSER_READ_CHARS = 100_000
export const DEFAULT_BROWSER_EXTRACT_ITEMS = 50
export const MAX_BROWSER_EXTRACT_ITEMS = 500
export const MAX_BROWSER_FIELDS = 20
export const MAX_BROWSER_SELECTOR_CHARS = 500
export const MAX_BROWSER_VALUE_CHARS = 4_000
export const MAX_BROWSER_OUTPUT_BYTES = 1_000_000

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const COMMAND = /^[A-Za-z0-9._-]+$/
const HOST = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i

export interface CommandBrowserDriverConfig {
  kind: 'command'
  /** Absolute path, `~/` path, or a bare executable name resolved on PATH. */
  command: string
  args: string[]
  /** Extra environment names copied from the parent into the driver. */
  env: string[]
  timeoutMs: number
}

export interface HttpBrowserDriverConfig {
  kind: 'http'
  /** https, or http on a loopback host for local development. */
  url: string
  /** Environment name holding a bearer token. Optional. */
  tokenEnv?: string
  timeoutMs: number
}

export type BrowserDriverConfig = CommandBrowserDriverConfig | HttpBrowserDriverConfig

export interface BrowserErrandConfig {
  driver: BrowserDriverConfig
  /** Exact hosts or `*.suffix` patterns. A URL outside this list is refused. */
  allowedHosts: string[]
  maxReadChars: number
  maxExtractItems: number
}

export interface BrowserErrandRequest {
  protocol: typeof BROWSER_PROTOCOL
  action: BrowserErrandAction
  /** Stable Worker session id; a stateful driver may key its page state on it. */
  session: string
  url?: string
  selector?: string
  fields?: { selector: string; value: string }[]
  /** Owner allowlist; fill drivers must check the active page before applying values. */
  allowedHosts?: string[]
}

export interface BrowserDriver {
  readonly kind: 'command' | 'http'
  /**
   * Run one request and return the unwrapped result object (for example, an
   * object with a top-level `url`). Reject on failure. The `{ok, result}` or
   * `{ok, error}` envelope is only the command/HTTP wire contract.
   */
  run(request: BrowserErrandRequest): Promise<Record<string, unknown>>
  /** Kill any in-flight driver work. Called on Runtime shutdown. */
  killAll?(): void
}

export interface BrowserErrandResult {
  action: BrowserErrandAction
  url?: string
  title?: string
  text?: string
  items?: string[]
  filled?: number
  truncated?: boolean
}

export interface BrowserErrandsOptions {
  log?: (line: string) => void
  /** Concurrent driver calls across all workers. */
  maxConcurrent?: number
}

/**
 * Read the owner's browser-errand configuration. A file wins over the
 * environment seed. Missing or blank configuration means "disabled", not an
 * error; a malformed value throws so the owner can fix it.
 */
export function loadBrowserErrands(
  home: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): BrowserErrandConfig | undefined {
  const file = path.join(home, BROWSER_ERRANDS_FILE)
  let content: string | undefined
  try {
    content = fs.readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw new UserError(`${BROWSER_ERRANDS_FILE} could not be read: ${messageOf(error)}`)
    }
  }

  let raw: unknown
  if (content !== undefined) {
    // A blank file is disabled, and it also suppresses the environment seed:
    // the file wins, including when the owner blanks it.
    if (!content.trim()) return undefined
    try {
      raw = JSON.parse(content)
    } catch (error) {
      throw new UserError(`${BROWSER_ERRANDS_FILE} is not valid JSON: ${messageOf(error)}`)
    }
  } else {
    const seed = env[BROWSER_ERRANDS_ENV]?.trim()
    if (!seed) return undefined
    try {
      raw = JSON.parse(seed)
    } catch (error) {
      throw new UserError(`${BROWSER_ERRANDS_ENV} is not valid JSON: ${messageOf(error)}`)
    }
  }
  return normalizeBrowserErrands(raw)
}

export function normalizeBrowserErrands(raw: unknown): BrowserErrandConfig | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UserError(`${BROWSER_ERRANDS_FILE} must be a JSON object`)
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!['enabled', 'driver', 'allowedHosts', 'maxReadChars', 'maxExtractItems'].includes(key)) {
      throw new UserError(`${BROWSER_ERRANDS_FILE} has unknown key ${key}`)
    }
  }
  if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
    throw new UserError(`${BROWSER_ERRANDS_FILE} enabled must be a boolean`)
  }
  // Default off: only an explicit `"enabled": true` registers any tool.
  if (record.enabled !== true) return undefined

  const driver = normalizeDriver(record.driver)
  const allowedHosts = normalizeAllowedHosts(record.allowedHosts)
  const maxReadChars = boundedInt(
    record.maxReadChars,
    'maxReadChars',
    DEFAULT_BROWSER_READ_CHARS,
    MAX_BROWSER_READ_CHARS,
  )
  const maxExtractItems = boundedInt(
    record.maxExtractItems,
    'maxExtractItems',
    DEFAULT_BROWSER_EXTRACT_ITEMS,
    MAX_BROWSER_EXTRACT_ITEMS,
  )
  return { driver, allowedHosts, maxReadChars, maxExtractItems }
}

function normalizeDriver(raw: unknown): BrowserDriverConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UserError(`${BROWSER_ERRANDS_FILE} needs a driver object`)
  }
  const record = raw as Record<string, unknown>
  if (record.kind === 'command') {
    assertKeys(record, 'driver', ['kind', 'command', 'args', 'env', 'timeoutMs'])
    const command = nonEmptyField(record.command, 'driver.command')
    if (/[\0\r\n]/.test(command)) throw new UserError('driver.command must be one line without NUL')
    const expanded = command.startsWith('~/') ? path.join(os.homedir(), command.slice(2)) : command
    const bareName = !expanded.startsWith('-') && COMMAND.test(expanded)
    if (!path.isAbsolute(expanded) && !bareName) {
      throw new UserError(
        'driver.command must be an absolute path, a ~/ path, or a bare executable name, not a shell string',
      )
    }
    const args = record.args === undefined ? [] : record.args
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
      throw new UserError('driver.args must be an array of strings without NUL')
    }
    const env = record.env === undefined ? [] : record.env
    if (!Array.isArray(env) || env.some(name => typeof name !== 'string' || !ENV_NAME.test(name))) {
      throw new UserError('driver.env must be an array of environment names')
    }
    return {
      kind: 'command',
      command: expanded,
      args: [...args] as string[],
      env: [...env] as string[],
      timeoutMs: timeoutField(record.timeoutMs, 'driver.timeoutMs'),
    }
  }
  if (record.kind === 'http') {
    assertKeys(record, 'driver', ['kind', 'url', 'tokenEnv', 'timeoutMs'])
    const rawUrl = nonEmptyField(record.url, 'driver.url')
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      throw new UserError('driver.url must be an absolute URL')
    }
    if (url.username || url.password) {
      throw new UserError('driver.url must not contain credentials; use tokenEnv')
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
      throw new UserError('driver.url must use https (http is allowed only on loopback)')
    }
    let tokenEnv: string | undefined
    if (record.tokenEnv !== undefined) {
      tokenEnv = nonEmptyField(record.tokenEnv, 'driver.tokenEnv')
      if (!ENV_NAME.test(tokenEnv)) throw new UserError('driver.tokenEnv must be an environment name')
    }
    return {
      kind: 'http',
      url: url.toString(),
      ...(tokenEnv ? { tokenEnv } : {}),
      timeoutMs: timeoutField(record.timeoutMs, 'driver.timeoutMs'),
    }
  }
  throw new UserError('driver.kind must be "command" or "http"')
}

function normalizeAllowedHosts(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new UserError(`${BROWSER_ERRANDS_FILE} allowedHosts must be a non-empty array`)
  }
  const seen = new Set<string>()
  return raw.map((value, index) => {
    if (typeof value !== 'string') throw new UserError(`allowedHosts #${index + 1} must be a string`)
    const host = value.trim().toLowerCase().replace(/\.$/, '')
    if (!HOST.test(host) || host.startsWith('-')) {
      throw new UserError(
        `allowedHosts #${index + 1} must be a hostname or *.hostname without a scheme, port, or path`,
      )
    }
    if (seen.has(host)) throw new UserError(`duplicate allowed host ${host}`)
    seen.add(host)
    return host
  })
}

/** Resolve the configured HTTP bearer token for inclusion in Runtime redaction. */
export function browserDriverSecretValues(
  config: BrowserErrandConfig | undefined,
  env: NodeJS.ProcessEnv,
): string[] {
  if (!config || config.driver.kind !== 'http' || !config.driver.tokenEnv) return []
  return [resolveHttpToken(config.driver, env)]
}

/** Build the driver, resolving the executable before any errand can run. */
export function createBrowserDriver(
  config: BrowserErrandConfig,
  options: { env?: NodeJS.ProcessEnv } = {},
): BrowserDriver {
  const env = options.env ?? process.env
  if (config.driver.kind === 'command') {
    const command = resolveExecutable(config.driver.command, env)
    return new CommandBrowserDriver({ ...config.driver, command }, { env })
  }
  assertSafeHttpDriverEndpoint(config.driver.url)
  return new HttpBrowserDriver(config.driver, { env })
}

function assertSafeHttpDriverEndpoint(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UserError('driver.url must be an absolute URL')
  }
  if (url.username || url.password) {
    throw new UserError('driver.url must not contain credentials; use tokenEnv')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new UserError('driver.url must use https (http is allowed only on loopback)')
  }
  return url
}

/** Fail closed when the owner's command is not executable right now. */
function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string {
  if (path.isAbsolute(command)) {
    try {
      if (!fs.statSync(command).isFile()) throw new Error('not a regular file')
      fs.accessSync(command, fs.constants.X_OK)
      return command
    } catch {
      throw new UserError(`browser driver command is not executable: ${command}`)
    }
  }
  if (!COMMAND.test(command) || command.startsWith('-')) {
    throw new UserError('browser driver command must be an absolute path or a bare executable name')
  }
  const pathValue = env.PATH ?? ''
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, command)
    try {
      if (!fs.statSync(candidate).isFile()) continue
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // Keep looking.
    }
  }
  throw new UserError(`browser driver command not found on PATH: ${command}`)
}

/** Reject an action the adapter must never issue, even if a caller casts. */
export function assertSafeBrowserAction(value: unknown): asserts value is BrowserErrandAction {
  if (typeof value !== 'string') throw new UserError('browser errand action must be a string')
  if ((IRREVERSIBLE_BROWSER_ACTIONS as readonly string[]).includes(value)) {
    throw new UserError(
      `irreversible browser action ${value} is not available; use request_approval and stop. `
      + 'This adapter does not submit, purchase, send, delete, or change account settings.',
    )
  }
  if (!(BROWSER_ERRAND_ACTIONS as readonly string[]).includes(value)) {
    throw new UserError(`unknown browser errand action ${value}; allowed: ${BROWSER_ERRAND_ACTIONS.join(', ')}`)
  }
}

/** Absolute http(s), no userinfo, and the host must be explicitly allowed. */
export function assertAllowedUrl(raw: string, allowedHosts: readonly string[]): URL {
  const text = raw.trim()
  if (!text) throw new UserError('browser_navigate needs an absolute http(s) URL')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new UserError('browser_navigate needs an absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UserError('browser_navigate only accepts http and https URLs')
  }
  if (url.username || url.password) {
    throw new UserError('browser_navigate refuses URLs with embedded credentials')
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!allowedHosts.some(pattern => hostMatches(host, pattern))) {
    throw new UserError(`browser_navigate host ${host} is not in the owner allowlist`)
  }
  return url
}

function hostMatches(host: string, pattern: string): boolean {
  const normalized = pattern.toLowerCase()
  if (!normalized.startsWith('*.')) return host === normalized
  const suffix = normalized.slice(1)
  return host.endsWith(suffix) && host.length > suffix.length
}

export function normalizeBrowserFields(raw: unknown): { selector: string; value: string }[] {
  if (!Array.isArray(raw)) throw new UserError('browser_fill fields must be a JSON array')
  if (raw.length === 0) throw new UserError('browser_fill needs at least one field')
  if (raw.length > MAX_BROWSER_FIELDS) {
    throw new UserError(`browser_fill accepts at most ${MAX_BROWSER_FIELDS} fields`)
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new UserError(`browser_fill field #${index + 1} must be an object`)
    }
    const record = entry as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (key !== 'selector' && key !== 'value') {
        throw new UserError(`browser_fill field #${index + 1} has unknown key ${key}; only selector and value are allowed`)
      }
    }
    const selector = typeof record.selector === 'string' ? record.selector.trim() : ''
    if (!selector || selector.length > MAX_BROWSER_SELECTOR_CHARS || selector.includes('\0')) {
      throw new UserError(
        `browser_fill field #${index + 1} needs a CSS selector of at most ${MAX_BROWSER_SELECTOR_CHARS} characters`,
      )
    }
    const value = record.value
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new UserError(`browser_fill field #${index + 1} value must be a string without NUL`)
    }
    if (value.length > MAX_BROWSER_VALUE_CHARS) {
      throw new UserError(`browser_fill field #${index + 1} value is too long (max ${MAX_BROWSER_VALUE_CHARS} characters)`)
    }
    return { selector, value }
  })
}

/**
 * The adapter. Every call is one bounded driver request; a stateful driver
 * keys its page state on the Worker session id. Results are clamped here, so a
 * driver cannot flood a model prompt.
 */
export class BrowserErrands {
  private readonly log: (line: string) => void
  private readonly maxConcurrent: number
  private readonly activeSessions = new Set<string>()
  private readonly blockedSessions = new Set<string>()
  private readonly assignmentSessions = new Map<string, { assignmentId: string; driverSession: string }>()
  private running = 0
  private closed = false

  constructor(
    private readonly driver: BrowserDriver,
    private readonly config: BrowserErrandConfig,
    options: BrowserErrandsOptions = {},
  ) {
    this.log = options.log ?? (() => {})
    this.maxConcurrent = options.maxConcurrent ?? 2
  }

  get driverKind(): 'command' | 'http' {
    return this.driver.kind
  }

  get allowedHosts(): string[] {
    return [...this.config.allowedHosts]
  }

  get limits(): { maxReadChars: number; maxExtractItems: number } {
    return {
      maxReadChars: this.config.maxReadChars,
      maxExtractItems: this.config.maxExtractItems,
    }
  }

  /** Give each new Assignment an isolated stateful-driver session. */
  beginAssignment(session: string, assignmentId: string): void {
    if (!session.trim() || !assignmentId.trim()) {
      throw new UserError('browser errand Assignment needs a session and id')
    }
    if (this.assignmentSessions.get(session)?.assignmentId === assignmentId) return
    this.assignmentSessions.set(session, {
      assignmentId,
      driverSession: `${session}#${assignmentId}`,
    })
  }

  /** Kill in-flight driver work and refuse later calls. */
  killAll(): void {
    this.closed = true
    this.driver.killAll?.()
  }

  describe(): {
    driver: 'command' | 'http'
    allowedHosts: string[]
    maxReadChars: number
    maxExtractItems: number
  } {
    return {
      driver: this.driver.kind,
      allowedHosts: this.allowedHosts,
      ...this.limits,
    }
  }

  async navigate(session: string, rawUrl: string): Promise<BrowserErrandResult> {
    const url = assertAllowedUrl(rawUrl, this.config.allowedHosts)
    const result = await this.run(
      { action: 'navigate', session, url: url.toString() },
      response => { optionalString(response, 'title') },
    )
    const finalUrl = this.assertAllowedResultUrl(result)
    const title = optionalString(result, 'title')
    return {
      action: 'navigate',
      url: finalUrl ?? url.toString(),
      ...(title ? { title } : {}),
    }
  }

  async read(session: string): Promise<BrowserErrandResult> {
    const result = await this.run(
      { action: 'read', session },
      response => {
        requiredString(response, 'text')
        optionalString(response, 'title')
        optionalBoolean(response, 'truncated')
      },
    )
    const text = requiredString(result, 'text')
    const url = this.assertAllowedResultUrl(result)
    const title = optionalString(result, 'title')
    const truncated = text.length > this.config.maxReadChars || result.truncated === true
    return {
      action: 'read',
      text: text.slice(0, this.config.maxReadChars),
      ...(url ? { url } : {}),
      ...(title ? { title } : {}),
      ...(truncated ? { truncated: true } : {}),
    }
  }

  async fill(session: string, fields: readonly { selector: string; value: string }[]): Promise<BrowserErrandResult> {
    // Re-validate here too: a caller outside the tool layer must not weaken this.
    const normalized = normalizeBrowserFields(fields)
    const validate = (response: Record<string, unknown>): void => {
      const filled = requiredInteger(response, 'filled')
      if (filled < 0 || filled > normalized.length) {
        throw new UserError(`browser driver reported ${filled} filled fields for ${normalized.length} fields`)
      }
    }
    const result = await this.run({
      action: 'fill',
      session,
      fields: normalized,
      allowedHosts: [...this.config.allowedHosts],
    }, validate)
    this.assertAllowedResultUrl(result)
    const filled = requiredInteger(result, 'filled')
    if (filled < 0 || filled > normalized.length) {
      throw new UserError(`browser driver reported ${filled} filled fields for ${normalized.length} fields`)
    }
    return { action: 'fill', filled }
  }

  async extract(session: string, selector?: string): Promise<BrowserErrandResult> {
    const normalizedSelector = selector?.trim()
    if (normalizedSelector && normalizedSelector.length > MAX_BROWSER_SELECTOR_CHARS) {
      throw new UserError(`browser_extract selector is too long (max ${MAX_BROWSER_SELECTOR_CHARS} characters)`)
    }
    const result = await this.run({
      action: 'extract',
      session,
      ...(normalizedSelector ? { selector: normalizedSelector } : {}),
    }, response => {
      const items = response.items
      if (!Array.isArray(items) || items.some(item => typeof item !== 'string')) {
        throw new UserError('browser driver returned invalid extract items')
      }
      optionalBoolean(response, 'truncated')
    })
    const rawItems = result.items as string[]
    const url = this.assertAllowedResultUrl(result)
    const items: string[] = []
    let remainingChars = this.config.maxReadChars
    let truncated = rawItems.length > this.config.maxExtractItems || result.truncated === true
    let returnedUrl: string | undefined = url
    if (url.length > remainingChars) {
      returnedUrl = undefined
      truncated = true
    } else {
      remainingChars -= url.length
    }
    const itemLimit = Math.min(rawItems.length, this.config.maxExtractItems)
    for (let index = 0; index < itemLimit; index += 1) {
      const item = rawItems[index]!
      if (item.length > remainingChars) {
        if (remainingChars > 0) items.push(item.slice(0, remainingChars))
        truncated = true
        remainingChars = 0
        break
      }
      items.push(item)
      remainingChars -= item.length
    }
    if (items.length < rawItems.length && items.length === this.config.maxExtractItems) truncated = true
    if (remainingChars === 0 && rawItems.slice(items.length).some(item => item.length > 0)) truncated = true
    return {
      action: 'extract',
      items,
      ...(returnedUrl ? { url: returnedUrl } : {}),
      ...(truncated ? { truncated: true } : {}),
    }
  }

  private async run(
    input: Omit<BrowserErrandRequest, 'protocol'>,
    validateResult?: (result: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>> {
    if (this.closed) throw new UserError('browser errands are shut down')
    assertSafeBrowserAction(input.action)
    if (!input.session.trim()) throw new UserError('browser errand needs a session')
    const driverSession = this.assignmentSessions.get(input.session)?.driverSession ?? input.session
    if (this.blockedSessions.has(driverSession)) {
      throw new UserError('browser session is blocked after an invalid driver response')
    }
    if (this.activeSessions.has(input.session)) {
      throw new UserError('browser session already has an in-flight action')
    }
    if (this.running >= this.maxConcurrent) {
      throw new UserError(`browser errand slots are busy (${this.running}/${this.maxConcurrent})`)
    }
    this.running += 1
    this.activeSessions.add(input.session)
    try {
      const result = await this.driver.run({ protocol: BROWSER_PROTOCOL, ...input, session: driverSession })
      this.assertAllowedResultUrl(result)
      validateResult?.(result)
      this.log(`[browser] action=${input.action} session=${input.session} driver=${this.driver.kind}`)
      return result
    } catch (error) {
      // A failed or disallowed action may have left the stateful browser on an
      // unknown page. Never send later field values to that Assignment session.
      this.blockedSessions.add(driverSession)
      throw error
    } finally {
      this.running -= 1
      this.activeSessions.delete(input.session)
    }
  }

  /**
   * The driver reports the post-action page URL for every operation. Treat it
   * as a trust boundary: navigation and page actions can redirect a session
   * after the initial owner-allowlisted URL has already been checked.
   */
  private assertAllowedResultUrl(result: Record<string, unknown>): string {
    const url = requiredString(result, 'url')
    return assertAllowedUrl(url, this.config.allowedHosts).toString()
  }
}

class CommandBrowserDriver implements BrowserDriver {
  readonly kind = 'command' as const
  private readonly env: NodeJS.ProcessEnv
  private readonly active = new Set<AbortController>()
  private closed = false

  constructor(
    private readonly config: CommandBrowserDriverConfig,
    options: { env: NodeJS.ProcessEnv },
  ) {
    this.env = options.env
  }

  killAll(): void {
    this.closed = true
    for (const controller of this.active) controller.abort()
    this.active.clear()
  }

  async run(request: BrowserErrandRequest): Promise<Record<string, unknown>> {
    assertSafeRequest(request)
    if (this.closed) throw new UserError('browser driver is shut down')
    const timeoutMs = Math.min(MAX_BROWSER_TIMEOUT_MS, this.config.timeoutMs)
    const controller = new AbortController()
    this.active.add(controller)
    const env = driverEnv(this.env, this.config.env)
    const secrets = driverSecretValues(this.env, this.config.env)
    const result = await spawnDriver({
      command: this.config.command,
      args: this.config.args,
      request,
      env,
      timeoutMs,
      signal: controller.signal,
      onDone: () => this.active.delete(controller),
    })
    if (this.closed) throw new UserError('browser driver is shut down')
    if (result.timedOut) throw new UserError(`browser driver timed out after ${timeoutMs} ms`)
    if (result.truncated) throw new UserError('browser driver output exceeded the capture limit')
    if (result.code !== 0) {
      const detail = redactKnownSecrets(result.stderr, secrets, secrets).replace(/\s+/g, ' ').trim().slice(0, 300)
      throw new UserError(
        `browser driver exited with code ${result.code ?? 'null'}${result.signal ? ` (${result.signal})` : ''}`
        + `${detail ? `: ${detail}` : ''}`,
      )
    }
    return parseEnvelope(result.stdout, secrets)
  }
}

function resolveHttpToken(config: HttpBrowserDriverConfig, env: NodeJS.ProcessEnv): string {
  const value = config.tokenEnv ? env[config.tokenEnv]?.trim() : undefined
  if (!config.tokenEnv || !value) {
    throw new UserError(`browser driver token env ${config.tokenEnv ?? ''} is not set`)
  }
  return value
}

class HttpBrowserDriver implements BrowserDriver {
  readonly kind = 'http' as const
  private readonly token?: string
  private readonly secrets: string[]
  private readonly active = new Set<AbortController>()
  private closed = false

  constructor(
    private readonly config: HttpBrowserDriverConfig,
    options: { env: NodeJS.ProcessEnv },
  ) {
    if (config.tokenEnv) this.token = resolveHttpToken(config, options.env)
    this.secrets = [...new Set([...secretValues(options.env), ...(this.token ? [this.token] : [])])]
  }

  killAll(): void {
    this.closed = true
    for (const controller of this.active) controller.abort()
    this.active.clear()
  }

  async run(request: BrowserErrandRequest): Promise<Record<string, unknown>> {
    assertSafeRequest(request)
    if (this.closed) throw new UserError('browser driver is shut down')
    const timeoutMs = Math.min(MAX_BROWSER_TIMEOUT_MS, this.config.timeoutMs)
    const controller = new AbortController()
    this.active.add(controller)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(request),
        signal: controller.signal,
        // A redirect could escape the endpoint the owner configured.
        redirect: 'manual',
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new UserError(`browser driver returned HTTP ${response.status}`)
      }
      const text = await readBoundedResponseBody(response.body)
      return parseEnvelope(text, this.secrets)
    } catch (error) {
      if (this.closed) throw new UserError('browser driver is shut down')
      if (controller.signal.aborted) throw new UserError(`browser driver timed out after ${timeoutMs} ms`)
      if (error instanceof UserError) throw error
      throw new UserError(`browser driver request failed: ${messageOf(error)}`)
    } finally {
      this.active.delete(controller)
      clearTimeout(timer)
    }
  }
}

function assertSafeRequest(request: BrowserErrandRequest): void {
  if (!request || typeof request !== 'object') throw new UserError('browser errand request must be an object')
  if (request.protocol !== BROWSER_PROTOCOL) throw new UserError(`browser errand protocol must be ${BROWSER_PROTOCOL}`)
  assertSafeBrowserAction(request.action)
  if (typeof request.session !== 'string' || !request.session.trim()) {
    throw new UserError('browser errand needs a session')
  }
  if (request.action === 'fill') {
    normalizeAllowedHosts(request.allowedHosts)
  }
}

interface SpawnResult {
  code: number | null
  signal?: NodeJS.Signals
  timedOut: boolean
  truncated: boolean
  stdout: string
  stderr: string
}

function spawnDriver(input: {
  command: string
  args: string[]
  request: BrowserErrandRequest
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal: AbortSignal
  onDone?: () => void
}): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(input.command, input.args, {
        env: input.env,
        // Lead a process group so best-effort cleanup can kill descendants too.
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      input.onDone?.()
      reject(new UserError(`could not start browser driver: ${messageOf(error)}`))
      return
    }
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let stderrTruncated = false
    let truncated = false
    let timedOut = false
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const finish = (result: SpawnResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal.removeEventListener('abort', abort)
      input.onDone?.()
      resolve(result)
    }
    const finishError = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal.removeEventListener('abort', abort)
      input.onDone?.()
      reject(new UserError(`could not start browser driver: ${messageOf(error)}`))
    }
    const stop = (timeout: boolean): void => {
      if (settled) return
      timedOut = timeout
      // Process cleanup is best effort. Settle and close our pipe ends regardless
      // of whether a descendant inherited them or survives in another group.
      killGroup(child.pid, child)
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.stderr?.destroy()
      finish({
        code: null,
        signal: 'SIGKILL',
        timedOut,
        truncated,
        stdout,
        stderr: stderrTruncated ? '[stderr capture limit exceeded]' : stderr,
      })
    }
    const abort = (): void => stop(false)
    child.stdout?.on('data', (chunk: Buffer) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const remaining = MAX_BROWSER_OUTPUT_BYTES - stdoutBytes
      const length = Math.max(0, Math.min(bytes.byteLength, remaining))
      if (length > 0) {
        stdout += stdoutDecoder.write(bytes.subarray(0, length))
        stdoutBytes += length
      }
      if (length < bytes.byteLength) truncated = true
    })
    // Keep diagnostics bounded in bytes; if this cap is hit, suppress the whole
    // diagnostic so a credential split at the boundary cannot leak a fragment.
    child.stderr?.on('data', (chunk: Buffer) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const remaining = MAX_BROWSER_OUTPUT_BYTES - stderrBytes
      const length = Math.max(0, Math.min(bytes.byteLength, remaining))
      if (length > 0) {
        stderr += stderrDecoder.write(bytes.subarray(0, length))
        stderrBytes += length
      }
      if (length < bytes.byteLength) stderrTruncated = true
    })
    // The driver may exit before reading its request; that is an exit-code
    // error below, not an unhandled EPIPE.
    child.stdin?.on('error', () => {})
    timer = setTimeout(() => stop(true), input.timeoutMs)
    input.signal.addEventListener('abort', abort, { once: true })
    if (input.signal.aborted) {
      abort()
      return
    }
    child.on('error', finishError)
    child.on('close', (code, signal) => {
      if (settled) return
      stdout += stdoutDecoder.end()
      stderr += stderrDecoder.end()
      finish({
        code,
        ...(signal ? { signal } : {}),
        timedOut,
        truncated,
        stdout,
        stderr: stderrTruncated ? '[stderr capture limit exceeded]' : stderr,
      })
    })
    try {
      child.stdin?.end(JSON.stringify(input.request))
    } catch {
      // The close handler reports the real failure.
    }
  })
}

function killGroup(pid: number | undefined, child: ReturnType<typeof spawn>): void {
  if (pid == null) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

async function readBoundedResponseBody(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BROWSER_OUTPUT_BYTES) {
        await reader.cancel().catch(() => {})
        throw new UserError('browser driver response exceeded the capture limit')
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, size).toString('utf8')
  } finally {
    reader.releaseLock()
  }
}

function parseEnvelope(raw: string, secrets: readonly string[] = []): Record<string, unknown> {
  const text = raw.trim()
  if (!text) throw new UserError('browser driver returned no output')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new UserError('browser driver returned invalid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UserError('browser driver returned a non-object response')
  }
  const envelope = parsed as Record<string, unknown>
  if (envelope.ok !== true) {
    const detail = typeof envelope.error === 'string'
      ? redactKnownSecrets(envelope.error, secrets, secrets).replace(/\s+/g, ' ').trim().slice(0, 300)
      : 'unknown error'
    throw new UserError(`browser driver failed: ${detail}`)
  }
  const result = envelope.result
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new UserError('browser driver returned no result object')
  }
  return result as Record<string, unknown>
}

function driverEnv(parent: NodeJS.ProcessEnv, extra: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of [...ENV_ALLOWLIST, ...extra]) {
    const value = parent[name]
    if (typeof value === 'string') env[name] = value
  }
  return env
}

function driverSecretValues(parent: NodeJS.ProcessEnv, extra: readonly string[]): string[] {
  const env = driverEnv(parent, extra)
  const explicitlyConfigured = extra
    .map(name => parent[name])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  return [...new Set([...secretValues(env), ...explicitlyConfigured])]
}

function assertKeys(record: Record<string, unknown>, label: string, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new UserError(`${label} has unknown key ${key}`)
  }
}

function nonEmptyField(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new UserError(`${field} must be a non-empty string`)
  return value.trim()
}

function timeoutField(value: unknown, field: string): number {
  if (value === undefined) return DEFAULT_BROWSER_TIMEOUT_MS
  const number = typeof value === 'number' ? value : Number.NaN
  if (!Number.isInteger(number) || number < MIN_BROWSER_TIMEOUT_MS || number > MAX_BROWSER_TIMEOUT_MS) {
    throw new UserError(`${field} must be an integer between ${MIN_BROWSER_TIMEOUT_MS} and ${MAX_BROWSER_TIMEOUT_MS}`)
  }
  return number
}

function boundedInt(value: unknown, field: string, fallback: number, max: number): number {
  if (value === undefined) return fallback
  const number = typeof value === 'number' ? value : Number.NaN
  if (!Number.isInteger(number) || number < 1 || number > max) {
    throw new UserError(`${BROWSER_ERRANDS_FILE} ${field} must be an integer between 1 and ${max}`)
  }
  return number
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string') throw new UserError(`browser driver result needs a string ${field}`)
  return value
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new UserError(`browser driver result ${field} must be a string`)
  return value
}

function optionalBoolean(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new UserError(`browser driver result ${field} must be a boolean`)
  return value
}

function requiredInteger(record: Record<string, unknown>, field: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new UserError(`browser driver result needs an integer ${field}`)
  }
  return value
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

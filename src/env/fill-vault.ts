import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { UserError } from '../shared/errors.ts'

/**
 * Fill-only credential/payment store.
 *
 * The owner keeps passwords and card details here; a trusted form adapter asks
 * the vault to type one into a form. The vault never returns a value: the only
 * outputs are names, kinds, allowed field names, and a receipt. Callers that
 * build model context, replies, or ordinary tool results therefore have nothing
 * to read back.
 *
 * This is deliberately not a 1Password clone. It has no sync, no sharing, no
 * item database, and no read operation. A missing file, a non-private file, or
 * malformed JSON means fill is unavailable (fail closed), not "use an empty
 * vault".
 */

export type FillKind = 'password' | 'card'

export const PASSWORD_FIELDS = ['username', 'password'] as const
export const CARD_FIELDS = ['number', 'expiry', 'cvc', 'holder'] as const

export type FillField = typeof PASSWORD_FIELDS[number] | typeof CARD_FIELDS[number]

export interface FillEntrySummary {
  name: string
  kind: FillKind
  /** Field names that exist for this entry. Never values. */
  fields: FillField[]
}

/** A form adapter. It receives the value; it must not return or log it. */
export interface FillTarget {
  /** Human/owner-facing destination label, e.g. `browser:checkout.example`. */
  readonly label: string
  fill(field: FillField, value: string): Promise<void> | void
}

/** What the caller may learn: never a value, never a prefix. */
export interface FillReceipt {
  entry: string
  kind: FillKind
  target: string
  fields: FillField[]
  filledAt: string
}

interface PasswordEntry {
  kind: 'password'
  values: Partial<Record<'username' | 'password', string>>
}

interface CardEntry {
  kind: 'card'
  values: Partial<Record<'number' | 'expiry' | 'cvc' | 'holder', string>>
}

type FillEntry = PasswordEntry | CardEntry

export interface FillVaultOptions {
  now?: () => string
  /** Require the config file to be owner-only (default true). */
  requirePrivateFile?: boolean
}

export interface FillVaultLoad {
  vault?: FillVault
  /** Reason-only text for a startup log. Never includes config content. */
  reason?: string
}

export const VAULT_FILE = 'vault.json'
export const VAULT_FILE_ENV = 'DS_AGENT_VAULT_FILE'
export const MAX_FILL_VALUE_CHARS = 4096
const MAX_ENTRIES = 100
const MAX_NAME_CHARS = 64
const MAX_LABEL_CHARS = 120
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const UNSAFE_LABEL_CHARS =
  /[\u0000-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/g

export function fillVaultPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[VAULT_FILE_ENV]?.trim()
  return configured ? path.resolve(home, configured) : path.join(home, VAULT_FILE)
}

/** Collapse a target label to one line for the card/prompt. */
export function sanitizeFillLabel(value: string): string {
  return value.replace(UNSAFE_LABEL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS)
}

/**
 * Exact action text a Worker must put in `request_approval` before a fill.
 * Both `prepare_fill` and `fill_credential` derive it the same way, so the
 * approved card and the actual fill cannot drift.
 */
export function fillAction(input: {
  entry: string
  kind: FillKind
  target: string
  fields: readonly FillField[]
}): string {
  const noun = input.kind === 'card' ? 'card' : 'credential'
  return `Fill ${noun} "${input.entry}" into form "${input.target}" (${input.fields.join(', ')})`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validValue(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_FILL_VALUE_CHARS
    && !value.includes('\u0000')
}

function fieldsOf(entry: FillEntry): FillField[] {
  if (entry.kind === 'password') {
    return PASSWORD_FIELDS.filter(field => entry.values[field] !== undefined)
  }
  return CARD_FIELDS.filter(field => entry.values[field] !== undefined)
}

function parseEntry(name: string, raw: unknown): FillEntry {
  if (!NAME_PATTERN.test(name) || name.length > MAX_NAME_CHARS) {
    throw new Error('invalid entry name')
  }
  if (!isPlainObject(raw)) throw new Error('entry must be an object')
  const kind = raw.kind
  if (kind === 'password') {
    for (const key of Object.keys(raw)) {
      if (key !== 'kind' && key !== 'username' && key !== 'password') {
        throw new Error('unexpected password field')
      }
    }
    if (!validValue(raw.password)) throw new Error('password entry needs a password')
    const values: PasswordEntry['values'] = { password: raw.password }
    if (raw.username !== undefined) {
      if (!validValue(raw.username)) throw new Error('invalid username')
      values.username = raw.username
    }
    return { kind: 'password', values }
  }
  if (kind === 'card') {
    for (const key of Object.keys(raw)) {
      if (key !== 'kind' && !(CARD_FIELDS as readonly string[]).includes(key)) {
        throw new Error('unexpected card field')
      }
    }
    if (!validValue(raw.number)) throw new Error('card entry needs a number')
    const values: CardEntry['values'] = { number: raw.number }
    for (const field of ['expiry', 'cvc', 'holder'] as const) {
      const value = raw[field]
      if (value === undefined) continue
      if (!validValue(value)) throw new Error(`invalid card field ${field}`)
      values[field] = value
    }
    return { kind: 'card', values }
  }
  throw new Error('entry kind must be password or card')
}

/** A configured vault. Construct through `loadFillVault` in product code. */
export class FillVault {
  private readonly now: () => string

  private constructor(
    private readonly entries: ReadonlyMap<string, FillEntry>,
    options: FillVaultOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString())
  }

  /**
   * Parse a `{ "fill": { ... } }` document. Exposed for tests and for an
   * embedding app that already holds the document; it never accepts values in
   * a way that could be logged.
   */
  static fromDocument(raw: unknown, options: FillVaultOptions = {}): FillVault {
    if (!isPlainObject(raw)) throw new Error('vault config must be an object')
    // A flat `{ TOKEN: "..." }` file is the existing env-injection vault. It is
    // valid, but it carries no fill entries, so fill stays unavailable.
    if (raw.fill === undefined) return new FillVault(new Map(), options)
    const section = raw.fill
    if (!isPlainObject(section)) throw new Error('fill section must be an object')
    const names = Object.keys(section)
    if (names.length > MAX_ENTRIES) throw new Error('too many fill entries')
    const entries = new Map<string, FillEntry>()
    for (const name of names) entries.set(name, parseEntry(name, section[name]))
    return new FillVault(entries, options)
  }

  /** Names, kinds, and field names only. Safe for a tool result. */
  summary(): FillEntrySummary[] {
    return [...this.entries.entries()]
      .map(([name, entry]) => ({ name, kind: entry.kind, fields: fieldsOf(entry) }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  /**
   * Type one entry into a trusted form. No caller-supplied field is resolved
   * from outside this entry, and the returned receipt contains no value.
   */
  async fill(input: {
    entry: string
    target: FillTarget
    fields?: readonly FillField[]
  }): Promise<FillReceipt> {
    const entry = this.entries.get(input.entry)
    if (!entry) throw new UserError(`unknown vault entry ${input.entry}`)
    const available = fieldsOf(entry)
    const requested = input.fields === undefined
      ? available
      : [...new Set(input.fields)]
    if (requested.length === 0) throw new UserError('fill needs at least one field')
    for (const field of requested) {
      if (!available.includes(field)) {
        throw new UserError(`entry ${input.entry} has no ${field} field`)
      }
    }
    const label = sanitizeFillLabel(input.target.label)
    if (!label) throw new UserError('fill target needs a label')
    const values = entry.values as Partial<Record<FillField, string>>
    for (const field of requested) {
      const value = values[field]
      if (value === undefined) throw new UserError(`entry ${input.entry} is missing ${field}`)
      await input.target.fill(field, value)
    }
    return {
      entry: input.entry,
      kind: entry.kind,
      target: label,
      fields: requested,
      filledAt: this.now(),
    }
  }

  /**
   * Values for the Runtime's redaction list only. Never feed this to a tool
   * result, prompt, reply, log line, or Store document.
   */
  redactionValues(): string[] {
    const values: string[] = []
    for (const entry of this.entries.values()) {
      for (const value of Object.values(entry.values)) {
        if (typeof value === 'string' && value.length > 0) values.push(value)
      }
    }
    return [...new Set(values)].sort((left, right) => right.length - left.length)
  }
}

/** Load the owner's vault file. Absent, unsafe, or malformed means no vault. */
export function loadFillVault(
  filePath: string,
  options: FillVaultOptions = {},
): FillVaultLoad {
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    return { reason: 'missing' }
  }
  if (!stat.isFile()) return { reason: 'not-a-file' }
  if ((options.requirePrivateFile ?? true) && (stat.mode & 0o077) !== 0) {
    return { reason: 'insecure-mode' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return { reason: 'unreadable' }
  }
  try {
    const vault = FillVault.fromDocument(raw, options)
    if (vault.summary().length === 0) return { reason: 'no-fill-entries' }
    return { vault }
  } catch {
    return { reason: 'invalid' }
  }
}

export interface ProcessFillTargetOptions {
  command: string
  args?: readonly string[]
  label?: string
  timeoutMs?: number
  /** Extra child environment. Never put a fill value here. */
  env?: NodeJS.ProcessEnv
  /** Parent environment for the minimal allowlist (PATH/HOME/TMPDIR). */
  parentEnv?: NodeJS.ProcessEnv
}

/**
 * Adapter that hands a value to an owner-configured local helper over stdin.
 * No browser adapter is built in; this is the seam an owner can point at their
 * own automation. The helper must print nothing sensitive; even if it does,
 * its output is redacted before any error message leaves this class.
 */
export class ProcessFillTarget implements FillTarget {
  readonly label: string
  private readonly command: string
  private readonly args: string[]
  private readonly timeoutMs: number
  private readonly env: NodeJS.ProcessEnv

  constructor(options: ProcessFillTargetOptions) {
    if (!options.command.trim()) throw new Error('fill command required')
    this.command = options.command
    this.args = [...(options.args ?? [])]
    this.timeoutMs = Number.isSafeInteger(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? options.timeoutMs!
      : 5_000
    this.label = sanitizeFillLabel(options.label ?? path.basename(options.command))
    if (!this.label) throw new Error('fill target label required')
    const parent = options.parentEnv ?? process.env
    this.env = {
      PATH: parent.PATH ?? '',
      ...(parent.HOME ? { HOME: parent.HOME } : {}),
      ...(parent.TMPDIR ? { TMPDIR: parent.TMPDIR } : {}),
      ...(options.env ?? {}),
    }
  }

  fill(field: FillField, value: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, this.args, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.env,
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const cap = 16_384
      const append = (current: string, chunk: Buffer): string =>
        current.length >= cap ? current : (current + String(chunk)).slice(0, cap)
      const clean = (text: string): string => text.split(value).join('[redacted]')
      const timer = setTimeout(() => child.kill('SIGKILL'), this.timeoutMs)
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }
      child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
      child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
      child.on('error', () => finish(() => reject(new UserError('fill helper could not start'))))
      child.on('close', code => finish(() => {
        if (code === 0) {
          resolve()
          return
        }
        const hint = clean(`${stdout}\n${stderr}`).replace(/\s+/g, ' ').trim().slice(0, 200)
        reject(new UserError(
          `fill helper failed (exit ${code ?? 'signal'})${hint ? `: ${hint}` : ''}`,
        ))
      }))
      child.stdin.on('error', () => undefined)
      child.stdin.end(`${JSON.stringify({ field, value })}\n`)
    })
  }
}

/** Opt-in helper configured by the owner; absent means no fill target. */
export function fillTargetFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProcessFillTarget | undefined {
  const command = env.DS_AGENT_FILL_COMMAND?.trim()
  if (!command) return undefined
  let args: string[] = []
  const rawArgs = env.DS_AGENT_FILL_ARGS?.trim()
  if (rawArgs) {
    try {
      const parsed = JSON.parse(rawArgs) as unknown
      if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) return undefined
      args = parsed as string[]
    } catch {
      return undefined
    }
  }
  const timeout = Number(env.DS_AGENT_FILL_TIMEOUT_MS)
  return new ProcessFillTarget({
    command,
    args,
    label: env.DS_AGENT_FILL_TARGET_LABEL?.trim() || path.basename(command),
    ...(Number.isSafeInteger(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
    parentEnv: env,
  })
}

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { UserError } from '../shared/errors.ts'
import { ENV_ALLOWLIST } from './sanitize.ts'

/**
 * Owner-configured local specialist agents (Claude Code, Codex, OpenCode,
 * Hermes, or a custom CLI). This is an execution surface, so it is opt-in,
 * allowlisted, and never takes a command from the model:
 *
 * - the owner names each agent and its argv in `local-agents.json` or
 *   `DS_AGENT_LOCAL_AGENTS`;
 * - the model only supplies an agent id and a task string;
 * - the task is one argv entry, never a shell string;
 * - cwd is the worker workspace, output and runtime are bounded, and the
 *   child receives only the base allowlist plus explicitly opted-in names.
 */
export interface LocalAgentSpec {
  /** Stable id the model may name. */
  id: string
  /** Absolute path or a bare executable name resolved on PATH. Never a shell string. */
  command: string
  /** Argv template. `{task}` and `{workspace}` are replaced as whole argv entries. */
  args?: string[]
  description?: string
  timeoutMs?: number
  maxOutputBytes?: number
  /** Extra environment names to copy from the parent, e.g. `ANTHROPIC_API_KEY`. */
  env?: string[]
}

export interface LocalAgentInfo {
  id: string
  description?: string
}

export interface LocalAgentRunResult {
  agent: string
  code: number | null
  signal?: string
  timedOut: boolean
  truncated: boolean
  stdout: string
  stderr: string
}

export interface LocalAgentRegistryOptions {
  env?: NodeJS.ProcessEnv
  workspace: (workerId: string) => string
  /** Default per-run timeout; a spec may lower it. */
  timeoutMs?: number
  /** Default per-stream capture cap; a spec may lower it. */
  maxOutputBytes?: number
  /** Concurrent runs across all workers. */
  maxConcurrent?: number
}

export const LOCAL_AGENTS_FILE = 'local-agents.json'
export const LOCAL_AGENTS_ENV = 'DS_AGENT_LOCAL_AGENTS'
export const DEFAULT_LOCAL_AGENT_TIMEOUT_MS = 120_000
export const MAX_LOCAL_AGENT_TIMEOUT_MS = 600_000
export const DEFAULT_LOCAL_AGENT_OUTPUT_BYTES = 200_000
export const MAX_LOCAL_AGENT_OUTPUT_BYTES = 1_000_000
export const MAX_LOCAL_AGENT_TASK_CHARS = 16_000
export const MAX_LOCAL_AGENTS = 16

const ID = /^[a-z][a-z0-9_-]{0,31}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const COMMAND = /^[A-Za-z0-9._-]+$/
const SPEC_KEYS = new Set(['id', 'command', 'args', 'description', 'timeoutMs', 'maxOutputBytes', 'env'])

/**
 * Read the owner's local-agent list. A file wins over the environment seed.
 * Missing or blank configuration means "no local agents", not an error; a
 * malformed entry fails loudly so the owner can fix it.
 */
export function loadLocalAgents(
  home: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): LocalAgentSpec[] {
  const file = path.join(home, LOCAL_AGENTS_FILE)
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw new UserError(`${LOCAL_AGENTS_FILE} is not valid JSON: ${messageOf(error)}`)
    }
    const seed = env[LOCAL_AGENTS_ENV]?.trim()
    if (!seed) return []
    try {
      raw = JSON.parse(seed)
    } catch (seedError) {
      throw new UserError(`${LOCAL_AGENTS_ENV} is not valid JSON: ${messageOf(seedError)}`)
    }
  }
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { agents?: unknown }).agents)
      ? (raw as { agents: unknown[] }).agents
      : undefined
  if (!list) throw new UserError(`${LOCAL_AGENTS_FILE} must be an array or {"agents": [...]}`)
  return normalizeLocalAgents(list)
}

export function normalizeLocalAgents(list: readonly unknown[]): LocalAgentSpec[] {
  if (list.length > MAX_LOCAL_AGENTS) {
    throw new UserError(`at most ${MAX_LOCAL_AGENTS} local agents may be configured`)
  }
  const seen = new Set<string>()
  return list.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new UserError(`local agent #${index + 1} must be an object`)
    }
    const raw = entry as Record<string, unknown>
    for (const key of Object.keys(raw)) {
      if (!SPEC_KEYS.has(key)) throw new UserError(`local agent #${index + 1} has unknown key ${key}`)
    }
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!ID.test(id)) throw new UserError(`local agent id ${JSON.stringify(raw.id)} is invalid`)
    if (seen.has(id)) throw new UserError(`duplicate local agent id ${id}`)
    seen.add(id)

    const command = typeof raw.command === 'string' ? raw.command.trim() : ''
    if (!command || command.includes('\0') || command.includes('\n') || command.includes('\r')) {
      throw new UserError(`local agent ${id} needs a command`)
    }
    if (!path.isAbsolute(command) && !COMMAND.test(command)) {
      throw new UserError(
        `local agent ${id} command must be an absolute path or a bare executable name, not a shell string`,
      )
    }

    const args = raw.args === undefined ? [] : raw.args
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
      throw new UserError(`local agent ${id} args must be an array of strings without NUL`)
    }

    if (raw.description !== undefined && typeof raw.description !== 'string') {
      throw new UserError(`local agent ${id} description must be a string`)
    }
    const description = raw.description === undefined ? undefined : raw.description.trim()
    if (description && (description.length > 200 || /[\r\n]/.test(description))) {
      throw new UserError(`local agent ${id} description must be one line, at most 200 characters`)
    }

    const env = raw.env === undefined ? [] : raw.env
    if (!Array.isArray(env) || env.some(name => typeof name !== 'string' || !ENV_NAME.test(name))) {
      throw new UserError(`local agent ${id} env must be an array of environment names`)
    }

    return {
      id,
      command: command.startsWith('~/') ? path.join(os.homedir(), command.slice(2)) : command,
      ...(args.length ? { args: [...args] as string[] } : {}),
      ...(description ? { description } : {}),
      ...(raw.timeoutMs === undefined ? {} : {
        timeoutMs: boundedInt(raw.timeoutMs, id, 'timeoutMs', 50, MAX_LOCAL_AGENT_TIMEOUT_MS),
      }),
      ...(raw.maxOutputBytes === undefined ? {} : {
        maxOutputBytes: boundedInt(raw.maxOutputBytes, id, 'maxOutputBytes', 100, MAX_LOCAL_AGENT_OUTPUT_BYTES),
      }),
      ...(env.length ? { env: [...env] as string[] } : {}),
    }
  })
}

export class LocalAgentRegistry {
  private readonly specs = new Map<string, LocalAgentSpec>()
  private readonly env: NodeJS.ProcessEnv
  private readonly workspace: (workerId: string) => string
  private readonly defaultTimeoutMs: number
  private readonly defaultMaxOutputBytes: number
  private readonly maxConcurrent: number
  private running = 0

  constructor(agents: readonly LocalAgentSpec[], options: LocalAgentRegistryOptions) {
    for (const spec of normalizeLocalAgents(agents)) this.specs.set(spec.id, spec)
    this.env = options.env ?? process.env
    this.workspace = options.workspace
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_LOCAL_AGENT_TIMEOUT_MS
    this.defaultMaxOutputBytes = options.maxOutputBytes ?? DEFAULT_LOCAL_AGENT_OUTPUT_BYTES
    this.maxConcurrent = options.maxConcurrent ?? 2
  }

  list(): LocalAgentInfo[] {
    return [...this.specs.values()].map(spec => ({
      id: spec.id,
      ...(spec.description ? { description: spec.description } : {}),
    }))
  }

  get(id: string): LocalAgentSpec | undefined {
    return this.specs.get(id)
  }

  async run(id: string, task: string, workerId: string): Promise<LocalAgentRunResult> {
    const spec = this.specs.get(id)
    if (!spec) {
      const configured = [...this.specs.keys()].join(', ') || 'none'
      throw new UserError(`unknown local agent ${id || '(empty)'}; configured: ${configured}`)
    }
    const body = task.trim()
    if (!body) throw new UserError(`delegate_agent needs a task for ${id}`)
    if (body.length > MAX_LOCAL_AGENT_TASK_CHARS) {
      throw new UserError(`delegate_agent task is too long (max ${MAX_LOCAL_AGENT_TASK_CHARS} characters)`)
    }
    if (this.running >= this.maxConcurrent) {
      throw new UserError(`local agent slots are busy (${this.running}/${this.maxConcurrent})`)
    }
    const cwd = this.workspace(workerId)
    fs.mkdirSync(cwd, { recursive: true })
    const args = (spec.args ?? []).map(arg =>
      arg.replaceAll('{task}', body).replaceAll('{workspace}', cwd))
    if (!(spec.args ?? []).some(arg => arg.includes('{task}'))) args.push(body)
    const timeoutMs = Math.min(
      MAX_LOCAL_AGENT_TIMEOUT_MS,
      spec.timeoutMs ?? this.defaultTimeoutMs,
    )
    const maxOutputBytes = Math.min(
      MAX_LOCAL_AGENT_OUTPUT_BYTES,
      spec.maxOutputBytes ?? this.defaultMaxOutputBytes,
    )
    this.running += 1
    try {
      return await spawnAgent({
        spec,
        args,
        cwd,
        env: agentEnv(this.env, spec.env ?? []),
        timeoutMs,
        maxOutputBytes,
      })
    } finally {
      this.running -= 1
    }
  }
}

/** Explicitly listed secret-named vars are allowed; unrelated secrets are not copied. */
function agentEnv(parent: NodeJS.ProcessEnv, extra: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of [...ENV_ALLOWLIST, ...extra]) {
    const value = parent[name]
    if (typeof value === 'string') env[name] = value
  }
  return env
}

function spawnAgent(input: {
  spec: LocalAgentSpec
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  maxOutputBytes: number
}): Promise<LocalAgentRunResult> {
  const { spec, args, cwd, env, timeoutMs, maxOutputBytes } = input
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(spec.command, args, {
        cwd,
        env,
        // Lead a process group so a timeout can kill grandchildren too.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(new UserError(`could not start local agent ${spec.id}: ${messageOf(error)}`))
      return
    }
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let settled = false
    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= maxOutputBytes) {
        truncated = true
        return current
      }
      const next = current + String(chunk)
      if (next.length <= maxOutputBytes) return next
      truncated = true
      return next.slice(0, maxOutputBytes)
    }
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child.pid, child)
    }, timeoutMs)
    const settle = (result: LocalAgentRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new UserError(`could not start local agent ${spec.id}: ${messageOf(error)}`))
    })
    child.on('close', (code, signal) => {
      settle({
        agent: spec.id,
        code,
        ...(signal ? { signal } : {}),
        timedOut,
        truncated,
        stdout,
        stderr,
      })
    })
  })
}

function killGroup(pid: number | undefined, child: ReturnType<typeof spawn>): void {
  if (pid == null) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

function boundedInt(value: unknown, id: string, field: string, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number.NaN
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new UserError(`local agent ${id} ${field} must be an integer between ${min} and ${max}`)
  }
  return number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { EnvPort, EnvRunOptions } from '../shared/ports.ts'
import { UserError } from '../shared/errors.ts'
import { allowlistedEnv, ENV_ALLOWLIST, redactSecrets, secretValues } from './sanitize.ts'
import type { Vault } from './vault.ts'
import { readIsolationFromEnv, sandboxEnabledFromEnv, wrapBashCommand, type SandboxPolicy } from './seccomp.ts'

export interface LocalEnvOptions {
  timeoutMs?: number
  /** Cap for one command's stdout/stderr. Excess is truncated, not buffered forever. */
  maxOutputBytes?: number
  /** Parent environment. Only allowlisted names are copied into the child. */
  env?: NodeJS.ProcessEnv
  allowlist?: readonly string[]
  /** External vault — values inject into child env only, never into tool text. */
  vault?: Vault
  /** Secret names from the vault to inject into child processes. */
  vaultNames?: readonly string[]
  sandbox?: SandboxPolicy
  /**
   * Opt-in strict read confinement. Overrides `DS_AGENT_SANDBOX_READ_ISOLATION`
   * and the sandbox policy's own flag; default is off.
   */
  readIsolation?: boolean
  /** Extra absolute host paths allowed read-only in strict mode. */
  readRoots?: readonly string[]
}

/**
 * Local workspace per worker. Speculative bash and writes use a scratch
 * directory under `speculative/` so a discard can delete them.
 * A cloud executor would implement the same EnvPort and run bash off-box.
 *
 * The child process receives an allowlisted environment. Secret values from the
 * parent are stripped from stdout, stderr, and file reads before they can become
 * tool results or model prompts.
 */
export class LocalEnv implements EnvPort {
  private readonly timeoutMs: number
  private readonly maxOutputBytes: number
  private readonly childEnv: NodeJS.ProcessEnv
  private readonly secrets: readonly string[]
  private readonly vault?: Vault
  private readonly vaultNames: readonly string[]
  private readonly sandbox: SandboxPolicy

  constructor(private readonly root: string, timeoutOrOptions: number | LocalEnvOptions = {}) {
    fs.mkdirSync(root, { recursive: true })
    const options: LocalEnvOptions = typeof timeoutOrOptions === 'number'
      ? { timeoutMs: timeoutOrOptions }
      : timeoutOrOptions
    const env = options.env ?? process.env
    this.timeoutMs = options.timeoutMs ?? 5_000
    this.maxOutputBytes = options.maxOutputBytes ?? 1_000_000
    this.childEnv = allowlistedEnv(env, options.allowlist ?? ENV_ALLOWLIST)
    this.vault = options.vault
    this.vaultNames = options.vaultNames ?? []
    // Parse the env value even when an explicit flag is present so a garbage
    // value fails closed instead of being silently shadowed.
    const envReadIsolation = readIsolationFromEnv(env)
    const sandbox: SandboxPolicy = options.sandbox ?? { enabled: sandboxEnabledFromEnv(env) }
    this.sandbox = {
      ...sandbox,
      readIsolation: options.readIsolation ?? sandbox.readIsolation ?? envReadIsolation,
      readRoots: [...(sandbox.readRoots ?? []), ...(options.readRoots ?? [])],
    }
    const vaultSecrets = this.vault
      ? Object.values(this.vault.resolveForChild(this.vaultNames)).filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      )
      : []
    this.secrets = [...secretValues(env), ...vaultSecrets]
  }


  /** Read-only config for `ds-agent health` and tests. */
  get readIsolation(): boolean {
    return this.sandbox.readIsolation === true
  }

  workspace(workerId: string): string {
    const dir = path.join(this.root, workerId)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  isolatedWorkspace(workerId: string): string {
    const dir = this.scratch(workerId)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  discardIsolated(workerId: string): void {
    fs.rmSync(this.scratch(workerId), { recursive: true, force: true })
  }

  promoteIsolated(workerId: string): void {
    const from = this.scratch(workerId)
    if (!fs.existsSync(from)) return
    const to = this.workspace(workerId)
    fs.cpSync(from, to, { recursive: true })
    fs.rmSync(from, { recursive: true, force: true })
  }

  async bash(
    workerId: string,
    command: string,
    opts?: EnvRunOptions,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const isolated = opts?.isolated === true
    if (!command.trim()) throw new UserError('empty command')
    if (isolated && leavesWorkdir(command)) {
      throw new UserError('speculative command leaves the isolated workdir')
    }
    const cwd = isolated ? this.isolatedWorkspace(workerId) : this.workspace(workerId)
    const wrapped = wrapBashCommand(command, {
      ...this.sandbox,
      writableRoots: [cwd],
      allowNetwork: isolated ? false : this.sandbox.allowNetwork,
    })
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const [bin, ...args] = wrapped.argv
      // detached: the shell leads its own process group, so a timeout can kill the
      // grandchildren too. Without this, `sleep 3600` keeps the pipe open and the
      // worker turn never returns (docs/REVIEW.md H9).
      const child = spawn(bin, args, {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.shellEnv(cwd, isolated),
      })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      const append = (current: string, chunk: Buffer): string => {
        if (current.length >= this.maxOutputBytes) return current
        const next = current + String(chunk)
        if (next.length <= this.maxOutputBytes) return next
        return `${next.slice(0, this.maxOutputBytes)}\n[truncated]`
      }
      const killGroup = (): void => {
        if (!child.pid) return
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }
      const timer = setTimeout(() => {
        timedOut = true
        killGroup()
      }, this.timeoutMs)
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }
      child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
      child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
      child.on('error', error => {
        killGroup()
        finish(() => reject(error))
      })
      child.on('close', code => finish(() => resolve({
        code: timedOut ? 124 : (code ?? 1),
        stdout,
        stderr: timedOut
          ? `${stderr}\n[timeout] killed process group after ${this.timeoutMs}ms`
          : stderr,
      })))
    })
    return {
      code: result.code,
      stdout: redactSecrets(result.stdout, this.secrets),
      stderr: redactSecrets(result.stderr, this.secrets),
    }
  }

  async writeFile(workerId: string, relativePath: string, body: string, opts?: EnvRunOptions): Promise<string> {
    const { cwd, full } = this.safe(workerId, relativePath, opts?.isolated === true)
    // mkdirSync(recursive) follows symlinks, so a link planted inside the
    // workspace could create directories anywhere on the host before the
    // containment check ran. Refuse every existing link first.
    this.assertNoSymlink(cwd, full)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    const target = this.assertContained(cwd, full)
    const fd = fs.openSync(
      target,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | NO_FOLLOW,
    )
    try {
      fs.writeFileSync(fd, body)
    } finally {
      fs.closeSync(fd)
    }
    return full
  }

  async readFile(workerId: string, relativePath: string, opts?: EnvRunOptions): Promise<string> {
    const { cwd, full } = this.safe(workerId, relativePath, opts?.isolated === true)
    const target = this.assertContained(cwd, full)
    let fd: number
    try {
      fd = fs.openSync(target, fs.constants.O_RDONLY | NO_FOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw symlinkEscape()
      throw error
    }
    try {
      return redactSecrets(fs.readFileSync(fd, 'utf8'), this.secrets)
    } finally {
      fs.closeSync(fd)
    }
  }

  private shellEnv(cwd: string, isolated: boolean): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.childEnv }
    // Startup files can leak host state into a sandboxed shell and pollute stderr.
    delete env.BASH_ENV
    delete env.ENV
    if (this.vault && this.vaultNames.length > 0) {
      Object.assign(env, this.vault.resolveForChild(this.vaultNames))
    }
    if (isolated) {
      env.HOME = cwd
      env.TMPDIR = cwd
    }
    return env
  }

  private scratch(workerId: string): string {
    return path.join(this.root, 'speculative', this.safeId(workerId))
  }

  private safeId(workerId: string): string {
    if (!/^[\w.-]+$/.test(workerId)) throw new UserError('invalid worker id')
    return workerId
  }

  private safe(workerId: string, relativePath: string, isolated: boolean): { cwd: string; full: string } {
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
      throw new UserError('path escapes workspace')
    }
    const cwd = path.resolve(isolated ? this.isolatedWorkspace(workerId) : this.workspace(workerId))
    const full = path.resolve(cwd, relativePath)
    if (full !== cwd && !full.startsWith(`${cwd}${path.sep}`)) throw new UserError('path escapes workspace')
    return { cwd, full }
  }

  /**
   * A lexical containment check is not enough: a symlink inside the workspace
   * resolves elsewhere, and fs.writeFileSync/readFileSync follow it. Reject
   * any existing component of the relative path that is a link, including a
   * broken link; the OS-level O_NOFOLLOW guard covers the final component.
   */
  private assertNoSymlink(cwd: string, full: string): void {
    let current = cwd
    for (const part of path.relative(cwd, full).split(path.sep).filter(Boolean)) {
      current = path.join(current, part)
      let stat: fs.Stats
      try {
        stat = fs.lstatSync(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (stat.isSymbolicLink()) throw symlinkEscape()
    }
  }

  /** Resolve the real target and verify it is still under the workspace root. */
  private assertContained(cwd: string, full: string): string {
    const root = fs.realpathSync(cwd)
    let target: string
    try {
      target = fs.realpathSync(full)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // A new file: its parent was just created and must resolve inside.
      target = path.join(fs.realpathSync(path.dirname(full)), path.basename(full))
    }
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw symlinkEscape()
    return target
  }
}

const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0

function symlinkEscape(): UserError {
  return new UserError('path escapes workspace: symlinks are not allowed')
}

/**
 * Speculative shells are confined to a scratch directory. This is a text check,
 * not an OS boundary: it rejects parent/home escapes and any absolute path,
 * including one that follows a quote or sits inside a language string
 * (`open('/tmp/x','w')`), which the previous whitespace-only rule missed.
 * Shell expansion (`$(...)`, `${...}`, backticks) is rejected too, since the
 * expanded text is not visible to this check.
 * A real boundary still requires the OS sandbox (PLAN §9 T51).
 */
const SHELL_SUBSTITUTION = /\$\(|\$\{|`|\$'/
// Match path segments, not substrings: a regex like `a..b` is not an escape.
// Any non-word/non-path character delimits a segment, including shell
// operators (`cd ..;`, `..&&`), so operators cannot hide a parent step.
const PARENT_SEGMENT = /(?:^|[^\w.-])\.\.(?:$|[^\w.-])/
// `~` and named-user `~alice` both expand outside the scratch HOME.
const HOME_SEGMENT = /(?:^|[^\w.-])~/
// Escapes and empty-quote splicing that hide a dot from this text check:
// `cd \.\.`, `cd .''.`, `cd ."".`. This is defense in depth, not an OS boundary.
const ESCAPED_DOT = /\\\./
const SPLICED_DOT = /\.(?:''|"")\./

function leavesWorkdir(command: string): boolean {
  if (SHELL_SUBSTITUTION.test(command)) return true
  if (ESCAPED_DOT.test(command) || SPLICED_DOT.test(command)) return true
  if (PARENT_SEGMENT.test(command) || HOME_SEGMENT.test(command)) return true
  if (/\$(?:\{)?HOME\b/.test(command)) return true
  return /(?:^|[^\w.-])\/(?!\*)/.test(command)
}

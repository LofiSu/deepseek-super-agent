import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { EnvPort, EnvRunOptions } from '../shared/ports.ts'
import { UserError } from '../shared/errors.ts'
import { allowlistedEnv, ENV_ALLOWLIST, redactSecrets, secretValues } from './sanitize.ts'
import type { Vault } from './vault.ts'
import { sandboxEnabledFromEnv, wrapBashCommand, type SandboxPolicy } from './seccomp.ts'

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
    this.sandbox = options.sandbox ?? { enabled: sandboxEnabledFromEnv(env) }
    const vaultSecrets = this.vault
      ? Object.values(this.vault.resolveForChild(this.vaultNames)).filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      )
      : []
    this.secrets = [...secretValues(env), ...vaultSecrets]
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
    const full = this.safe(workerId, relativePath, opts?.isolated === true)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body)
    return full
  }

  async readFile(workerId: string, relativePath: string, opts?: EnvRunOptions): Promise<string> {
    const text = fs.readFileSync(this.safe(workerId, relativePath, opts?.isolated === true), 'utf8')
    return redactSecrets(text, this.secrets)
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

  private safe(workerId: string, relativePath: string, isolated: boolean): string {
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
      throw new UserError('path escapes workspace')
    }
    const cwd = path.resolve(isolated ? this.isolatedWorkspace(workerId) : this.workspace(workerId))
    const full = path.resolve(cwd, relativePath)
    if (full !== cwd && !full.startsWith(`${cwd}${path.sep}`)) throw new UserError('path escapes workspace')
    return full
  }
}

/**
 * Speculative shells are confined to a scratch directory. This is a text check,
 * not an OS boundary: it rejects parent/home escapes and any absolute path,
 * including one that follows a quote or sits inside a language string
 * (`open('/tmp/x','w')`), which the previous whitespace-only rule missed.
 * A real boundary still requires the OS sandbox (PLAN §9 T51).
 */
function leavesWorkdir(command: string): boolean {
  if (command.includes('..') || command.includes('~')) return true
  if (/\$(?:\{)?HOME\b/.test(command)) return true
  return /(?:^|[^\w.-])\/(?!\*)/.test(command)
}

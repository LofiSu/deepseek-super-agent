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
    const wrapped = wrapBashCommand(command, this.sandbox)
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const [bin, ...args] = wrapped.argv
      const child = spawn(bin, args, {
        cwd,
        timeout: this.timeoutMs,
        env: this.shellEnv(cwd, isolated),
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', reject)
      child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
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

function leavesWorkdir(command: string): boolean {
  if (command.includes('..') || command.includes('~')) return true
  return /(?:^|[\s<>|;&])\//.test(command)
}

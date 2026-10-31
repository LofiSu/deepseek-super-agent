import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { EnvPort } from '../shared/ports.ts'
import { UserError } from '../shared/errors.ts'
import { allowlistedEnv, ENV_ALLOWLIST, redactSecrets, secretValues } from './sanitize.ts'

export interface LocalEnvOptions {
  timeoutMs?: number
  /** Parent environment. Only allowlisted names are copied into the child. */
  env?: NodeJS.ProcessEnv
  allowlist?: readonly string[]
}

/**
 * Local workspace per worker. A cloud executor would implement the same EnvPort
 * and run bash off-box; the engine would not change.
 *
 * The child process receives an allowlisted environment. Secret values from the
 * parent are stripped from stdout, stderr, and file reads before they can become
 * tool results.
 */
export class LocalEnv implements EnvPort {
  private readonly timeoutMs: number
  private readonly childEnv: NodeJS.ProcessEnv
  private readonly secrets: readonly string[]

  constructor(private readonly root: string, timeoutOrOptions: number | LocalEnvOptions = {}) {
    fs.mkdirSync(root, { recursive: true })
    const options: LocalEnvOptions = typeof timeoutOrOptions === 'number'
      ? { timeoutMs: timeoutOrOptions }
      : timeoutOrOptions
    const env = options.env ?? process.env
    this.timeoutMs = options.timeoutMs ?? 5_000
    this.childEnv = allowlistedEnv(env, options.allowlist ?? ENV_ALLOWLIST)
    this.secrets = secretValues(env)
  }

  workspace(workerId: string): string {
    const dir = path.join(this.root, workerId)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  async bash(workerId: string, command: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const cwd = this.workspace(workerId)
    if (!command.trim()) throw new UserError('empty command')
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('bash', ['-c', command], { cwd, timeout: this.timeoutMs, env: this.childEnv })
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

  async writeFile(workerId: string, relativePath: string, body: string): Promise<string> {
    const full = this.safe(workerId, relativePath)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body)
    return full
  }

  async readFile(workerId: string, relativePath: string): Promise<string> {
    return redactSecrets(fs.readFileSync(this.safe(workerId, relativePath), 'utf8'), this.secrets)
  }

  private safe(workerId: string, relativePath: string): string {
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
      throw new UserError('path escapes workspace')
    }
    const cwd = path.resolve(this.workspace(workerId))
    const full = path.resolve(cwd, relativePath)
    if (full !== cwd && !full.startsWith(`${cwd}${path.sep}`)) throw new UserError('path escapes workspace')
    return full
  }
}

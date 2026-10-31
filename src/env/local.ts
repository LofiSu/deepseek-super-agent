import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { AgentError } from '../shared/errors.js'
import type { Env, EnvRunOptions, EnvRunResult } from '../shared/ports.js'

const DEFAULT_TIMEOUT_MS = 10_000

/** Bash runner locked to a workdir. It does not read or write domain rows. */
export class LocalEnv implements Env {
  readonly workdir: string

  constructor(workdir: string) {
    this.workdir = path.resolve(workdir)
    mkdirSync(this.workdir, { recursive: true })
  }

  run(command: string, options: EnvRunOptions = {}): Promise<EnvRunResult> {
    let cwd: string
    try {
      cwd = this.resolveCwd(options.cwd)
    } catch (error) {
      return Promise.reject(error)
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const child = spawn('bash', ['-c', command], {
        cwd,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: this.workdir,
          LANG: 'C',
        },
        timeout: timeoutMs,
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        stdout += chunk
      })
      child.stderr.on('data', chunk => {
        stderr += chunk
      })
      child.on('error', error => {
        reject(new AgentError('env_spawn', error.message))
      })
      child.on('close', (code, signal) => {
        if (signal) {
          reject(new AgentError('env_timeout', `command ended by ${signal}`))
          return
        }
        resolve({ exitCode: code ?? 1, stdout, stderr })
      })
    })
  }

  private resolveCwd(cwd: string | undefined): string {
    const resolved = cwd === undefined ? this.workdir : path.resolve(this.workdir, cwd)
    const relative = path.relative(this.workdir, resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new AgentError('env_escape', 'cwd escapes sandbox')
    }
    return resolved
  }
}

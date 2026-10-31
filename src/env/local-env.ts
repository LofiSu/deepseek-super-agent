import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { EnvPort, EnvRunOptions } from '../shared/ports.ts'
import { UserError } from '../shared/errors.ts'

/**
 * Local workspace per worker. Speculative bash and writes use a scratch
 * directory under `speculative/` so a discard can delete them.
 * A cloud executor would implement the same EnvPort and run bash off-box.
 */
export class LocalEnv implements EnvPort {
  constructor(private readonly root: string, private readonly timeoutMs = 5_000) {
    fs.mkdirSync(root, { recursive: true })
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
    return await new Promise((resolve, reject) => {
      const child = spawn('bash', ['-c', command], {
        cwd,
        timeout: this.timeoutMs,
        env: isolated ? { ...process.env, HOME: cwd, TMPDIR: cwd } : process.env,
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', reject)
      child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
    })
  }

  async writeFile(workerId: string, relativePath: string, body: string, opts?: EnvRunOptions): Promise<string> {
    const full = this.safe(workerId, relativePath, opts?.isolated === true)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body)
    return full
  }

  async readFile(workerId: string, relativePath: string, opts?: EnvRunOptions): Promise<string> {
    return fs.readFileSync(this.safe(workerId, relativePath, opts?.isolated === true), 'utf8')
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

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { EnvPort } from '../shared/ports.ts'
import { UserError } from '../shared/errors.ts'

/**
 * Local workspace per worker. A cloud executor would implement the same EnvPort
 * and run bash off-box; the engine would not change.
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

  async bash(workerId: string, command: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const cwd = this.workspace(workerId)
    if (!command.trim()) throw new UserError('empty command')
    return await new Promise((resolve, reject) => {
      const child = spawn('bash', ['-c', command], { cwd, timeout: this.timeoutMs })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', reject)
      child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
    })
  }

  async writeFile(workerId: string, relativePath: string, body: string): Promise<string> {
    const full = this.safe(workerId, relativePath)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body)
    return full
  }

  async readFile(workerId: string, relativePath: string): Promise<string> {
    return fs.readFileSync(this.safe(workerId, relativePath), 'utf8')
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

import type { Trigger } from './types.ts'

/** Scope port: whether a source listens to this trigger. */
export interface SourceScope {
  admit(trigger: Trigger): { listened: boolean; reason: string }
}

export interface SpillPort {
  put(body: string): string
  get(id: string): string | undefined
}

export interface EnvRunOptions {
  /** Speculative sessions execute under a scratch workdir that can be rolled back. */
  isolated?: boolean
}

/** Where a future cloud worker would plug in beside LocalEnv. */
export interface EnvPort {
  bash(workerId: string, command: string, opts?: EnvRunOptions): Promise<{ code: number; stdout: string; stderr: string }>
  writeFile(workerId: string, relativePath: string, body: string, opts?: EnvRunOptions): Promise<string>
  readFile(workerId: string, relativePath: string, opts?: EnvRunOptions): Promise<string>
  /** Delete a speculative scratch workspace. Presence means bash/write can be isolated. */
  discardIsolated?(workerId: string): void
  /** Move a speculative scratch workspace into the durable worker directory. */
  promoteIsolated?(workerId: string): void
}

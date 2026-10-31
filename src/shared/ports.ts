import type { Trigger } from './types.ts'

/** Scope port: whether a source listens to this trigger. */
export interface SourceScope {
  admit(trigger: Trigger): { listened: boolean; reason: string }
}

export interface SpillPort {
  put(body: string): string
  get(id: string): string | undefined
}

/** Where a future cloud worker would plug in beside LocalEnv. */
export interface EnvPort {
  bash(workerId: string, command: string): Promise<{ code: number; stdout: string; stderr: string }>
  writeFile(workerId: string, relativePath: string, body: string): Promise<string>
  readFile(workerId: string, relativePath: string): Promise<string>
}

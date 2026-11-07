import { spawnSync } from 'node:child_process'
import { readIsolationFromEnv, wrapBashCommand, type SandboxSystem } from './seccomp.ts'

/** Diagnostic only: wrapper on PATH and argv shape. Never implies kernel enforcement. */
export interface SandboxWrapperProbe {
  platform: string
  wrapper: 'sandbox-exec' | 'bwrap' | null
  /** False when sandbox is enabled but no wrapper exists — fail closed at bash time. */
  canWrap: boolean
}

export function probeSandboxWrapper(system: SandboxSystem = {
  platform: process.platform,
  available: bin => spawnSync('which', [bin], { stdio: 'ignore' }).status === 0,
  execPath: process.execPath,
}): SandboxWrapperProbe {
  const policy = {
    enabled: true,
    writableRoots: ['/tmp'],
    readIsolation: readIsolationFromEnv(process.env),
  }
  try {
    if (system.platform === 'darwin') {
      if (!system.available('sandbox-exec')) return { platform: system.platform, wrapper: null, canWrap: false }
      wrapBashCommand('true', policy, system)
      return { platform: system.platform, wrapper: 'sandbox-exec', canWrap: true }
    }
    if (system.platform === 'linux') {
      if (!system.available('bwrap')) return { platform: system.platform, wrapper: null, canWrap: false }
      wrapBashCommand('true', policy, system)
      return { platform: system.platform, wrapper: 'bwrap', canWrap: true }
    }
    return { platform: system.platform, wrapper: null, canWrap: false }
  } catch {
    return { platform: system.platform, wrapper: null, canWrap: false }
  }
}

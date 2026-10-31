import { platform } from 'node:os'
import { spawnSync } from 'node:child_process'

export interface SandboxPolicy {
  /** When true, prefer OS sandbox wrappers for bash. */
  enabled: boolean
  allowNetwork?: boolean
}

const DARWIN_PROFILE = `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow sysctl-read)
(allow file-read*)
(allow file-write* (subpath "/private/tmp") (subpath "/tmp") (subpath "/var/folders"))
(allow file-write* (literal "/dev/null"))
`

/**
 * Lightweight sandbox helper (PLAN T51). Darwin can wrap with sandbox-exec when
 * DS_AGENT_SANDBOX=1. Linux uses bwrap or unshare for a network namespace.
 * If neither is installed, it falls back to plain bash without isolation.
 */
export function wrapBashCommand(
  command: string,
  policy: SandboxPolicy,
  system: { platform: NodeJS.Platform; available: (bin: string) => boolean } = {
    platform: platform(),
    available: bin => spawnSync('which', [bin], { stdio: 'ignore' }).status === 0,
  },
): { argv: string[]; wrapped: boolean } {
  if (!policy.enabled) return { argv: ['bash', '-c', command], wrapped: false }
  if (system.platform === 'darwin') {
    const profile = policy.allowNetwork
      ? `${DARWIN_PROFILE}(allow network*)\n`
      : `${DARWIN_PROFILE}(deny network*)\n`
    return {
      argv: ['sandbox-exec', '-p', profile, 'bash', '-c', command],
      wrapped: true,
    }
  }
  if (system.platform === 'linux' && !policy.allowNetwork) {
    if (system.available('bwrap')) return {
      argv: ['bwrap', '--unshare-net', '--bind', '/', '/', '--', 'bash', '-c', command],
      wrapped: true,
    }
    if (system.available('unshare')) return {
      argv: ['unshare', '--net', '--', 'bash', '-c', command],
      wrapped: true,
    }
  }
  return { argv: ['bash', '-c', command], wrapped: false }
}

export function sandboxEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DS_AGENT_SANDBOX === '1' || env.DS_AGENT_SANDBOX === 'true'
}

import { platform } from 'node:os'

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
 * DS_AGENT_SANDBOX=1. Linux seccomp filtering is stubbed — callers still get deny-network hint.
 */
export function wrapBashCommand(command: string, policy: SandboxPolicy): { argv: string[]; wrapped: boolean } {
  if (!policy.enabled) return { argv: ['bash', '-c', command], wrapped: false }
  if (platform() === 'darwin') {
    const profile = policy.allowNetwork
      ? `${DARWIN_PROFILE}(allow network*)\n`
      : `${DARWIN_PROFILE}(deny network*)\n`
    return {
      argv: ['sandbox-exec', '-p', profile, 'bash', '-c', command],
      wrapped: true,
    }
  }
  // Linux: keep bash; true seccomp needs libseccomp — stub documents intent.
  return { argv: ['bash', '-c', command], wrapped: false }
}

export function sandboxEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DS_AGENT_SANDBOX === '1' || env.DS_AGENT_SANDBOX === 'true'
}

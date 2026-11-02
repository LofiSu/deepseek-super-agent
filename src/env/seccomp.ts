import { platform } from 'node:os'
import { spawnSync } from 'node:child_process'

export interface SandboxPolicy {
  /** When true, prefer OS sandbox wrappers for bash. */
  enabled: boolean
  allowNetwork?: boolean
  /** Worker workspace. Without this the sandboxed shell cannot write where it runs. */
  writableRoots?: readonly string[]
}

function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function darwinProfile(policy: SandboxPolicy): string {
  const writes = ['/private/tmp', '/tmp', '/var/folders', ...(policy.writableRoots ?? [])]
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow sysctl-read)',
    '(allow file-read*)',
  ]
  for (const dir of new Set(writes)) lines.push(`(allow file-write* (subpath ${sbplString(dir)}))`)
  lines.push('(allow file-write* (literal "/dev/null"))')
  lines.push(policy.allowNetwork ? '(allow network*)' : '(deny network*)')
  return `${lines.join('\n')}\n`
}

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
    return {
      argv: ['sandbox-exec', '-p', darwinProfile(policy), 'bash', '-c', command],
      wrapped: true,
    }
  }
  if (system.platform === 'linux' && !policy.allowNetwork) {
    const writable = (policy.writableRoots ?? []).flatMap(root => ['--bind', root, root])
    if (system.available('bwrap')) return {
      argv: ['bwrap', '--unshare-net', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', ...writable, '--', 'bash', '-c', command],
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

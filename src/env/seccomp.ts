import { platform } from 'node:os'
import { spawnSync } from 'node:child_process'
import { UserError } from '../shared/errors.ts'

export interface SandboxPolicy {
  /** Explicit `false` is a test/embedding opt-out. Production defaults to sandboxed. */
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
 * Wrap worker bash in an OS filesystem sandbox. An explicit `enabled: false`
 * opts out for tests/embedding; otherwise a missing sandbox wrapper is an error,
 * never a silent fallback to unsandboxed bash.
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
    if (!system.available('sandbox-exec')) {
      throw new UserError('worker bash requires sandbox-exec on Darwin')
    }
    return {
      argv: ['sandbox-exec', '-p', darwinProfile(policy), 'bash', '--noprofile', '--norc', '-c', command],
      wrapped: true,
    }
  }
  if (system.platform === 'linux') {
    if (!system.available('bwrap')) {
      throw new UserError('worker bash requires bubblewrap (bwrap) on Linux')
    }
    const writable = (policy.writableRoots ?? []).flatMap(root => ['--bind', root, root])
    return {
      argv: [
        'bwrap',
        ...(policy.allowNetwork ? [] : ['--unshare-net']),
        '--ro-bind', '/', '/',
        '--dev', '/dev',
        '--proc', '/proc',
        ...writable,
        '--',
        'bash', '--noprofile', '--norc', '-c', command,
      ],
      wrapped: true,
    }
  }
  throw new UserError(`worker bash has no filesystem sandbox on ${system.platform}`)
}

/** Sandboxing is the default; explicit LocalEnv options can still opt out. */
export function sandboxEnabledFromEnv(_env: NodeJS.ProcessEnv = process.env): boolean {
  return true
}

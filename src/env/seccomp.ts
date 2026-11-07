import { platform } from 'node:os'
import { dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { UserError } from '../shared/errors.ts'

export interface SandboxPolicy {
  /** Explicit `false` is a test/embedding opt-out. Production defaults to sandboxed. */
  enabled: boolean
  allowNetwork?: boolean
  /** Worker workspace. Without this the sandboxed shell cannot write where it runs. */
  writableRoots?: readonly string[]
  /**
   * Opt-in strict read confinement. When false or omitted the sandbox keeps
   * today's host-wide read access; it never changes the write/network rules.
   */
  readIsolation?: boolean
  /** Extra host paths exposed read-only in strict mode (absolute paths). */
  readRoots?: readonly string[]
  /** Linux bwrap: separate PID namespace when the wrapper supports it. */
  unsharePid?: boolean
}

export interface SandboxSystem {
  platform: NodeJS.Platform
  available: (bin: string) => boolean
  /** Existence probe for optional Linux binds. Injected in tests. */
  exists?: (path: string) => boolean
  /** Node executable whose directory must stay readable in strict mode. */
  execPath?: string
}

/**
 * Read-only Darwin paths for strict mode. Deliberately excludes `/` and the
 * user's whole home: a writable root inside home is allowed individually below.
 */
const DARWIN_READ_PATHS = [
  '/System',
  '/usr',
  '/bin',
  '/sbin',
  '/Library',
  '/private/etc',
  // `/etc` is a symlink to `/private/etc`; path resolution through the link
  // needs its own rule or `cat /etc/hosts` is denied.
  '/etc',
  '/private/var/db/dyld',
  '/dev',
  '/private/tmp',
  '/tmp',
  '/var/folders',
  '/private/var/folders',
] as const

/** System/toolchain roots bound read-only for bash and Node in strict Linux mode. */
const LINUX_READ_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/private/etc'] as const

function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Strict mode refuses roots that would re-expose the whole host or nothing. */
function assertStrictRoot(root: string, kind: string): void {
  const value = root.trim()
  if (value === '' || value === '/') {
    throw new UserError(`strict read isolation refuses ${kind} "${root}"`)
  }
}

function strictReadRoots(policy: SandboxPolicy): readonly string[] {
  for (const root of policy.writableRoots ?? []) assertStrictRoot(root, 'writable root')
  for (const root of policy.readRoots ?? []) assertStrictRoot(root, 'read root')
  return policy.readRoots ?? []
}

function darwinReadPaths(policy: SandboxPolicy, execPath: string): string[] {
  return [
    ...new Set([
      ...DARWIN_READ_PATHS,
      // Node itself may live outside the system paths (e.g. a version manager).
      dirname(execPath),
      ...(policy.writableRoots ?? []),
      ...strictReadRoots(policy),
    ]),
  ]
}

function darwinProfile(policy: SandboxPolicy, execPath: string): string {
  const writes = ['/private/tmp', '/tmp', '/var/folders', '/private/var/folders', ...(policy.writableRoots ?? [])]
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow sysctl-read)',
  ]
  if (policy.readIsolation) {
    // Path resolution starts at the filesystem root; without this literal rule
    // macOS aborts even `/bin/echo` under the strict subpath allowlist.
    lines.push('(allow file-read* (literal "/"))')
    for (const dir of darwinReadPaths(policy, execPath)) {
      lines.push(`(allow file-read* (subpath ${sbplString(dir)}))`)
    }
  } else {
    // Compatibility default: today's sandbox allows all host reads.
    lines.push('(allow file-read*)')
  }
  for (const dir of new Set(writes)) lines.push(`(allow file-write* (subpath ${sbplString(dir)}))`)
  lines.push('(allow file-write* (literal "/dev/null"))')
  lines.push(policy.allowNetwork ? '(allow network*)' : '(deny network*)')
  return `${lines.join('\n')}\n`
}

function linuxStrictArgv(policy: SandboxPolicy, exists: (path: string) => boolean): string[] {
  strictReadRoots(policy)
  const writable = (policy.writableRoots ?? []).flatMap(root => ['--bind', root, root])
  const reads = [
    ...LINUX_READ_PATHS
      .filter(path => exists(path))
      .flatMap(path => ['--ro-bind', path, path]),
    ...(policy.readRoots ?? []).flatMap(path => ['--ro-bind', path, path]),
  ]
  return [
    'bwrap',
    ...(policy.allowNetwork ? [] : ['--unshare-net']),
    ...(policy.unsharePid === true ? ['--unshare-pid'] : []),
    ...reads,
    '--dev', '/dev',
    '--proc', '/proc',
    '--ro-bind', '/tmp', '/tmp',
    ...writable,
    '--',
  ]
}

/**
 * Parse `DS_AGENT_SANDBOX_READ_ISOLATION`. Unset/empty/`0`/`false` keep today's
 * host-wide reads; `1`/`true`/`strict` opt in. Any other value fails closed.
 */
export function readIsolationFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DS_AGENT_SANDBOX_READ_ISOLATION
  if (raw === undefined) return false
  const value = raw.trim()
  if (value === '' || value === '0' || value === 'false') return false
  if (value === '1' || value === 'true' || value === 'strict') return true
  throw new UserError(`invalid DS_AGENT_SANDBOX_READ_ISOLATION: "${raw}" (expected 0, 1, false, true, or strict)`)
}

/**
 * Wrap worker bash in an OS filesystem sandbox. An explicit `enabled: false`
 * opts out for tests/embedding; otherwise a missing sandbox wrapper is an error,
 * never a silent fallback to unsandboxed bash.
 */
export function wrapBashCommand(
  command: string,
  policy: SandboxPolicy,
  system: SandboxSystem = {
    platform: platform(),
    available: bin => spawnSync('which', [bin], { stdio: 'ignore' }).status === 0,
  },
): { argv: string[]; wrapped: boolean } {
  if (!policy.enabled) return { argv: ['bash', '-c', command], wrapped: false }
  if (system.platform === 'darwin') {
    if (!system.available('sandbox-exec')) {
      throw new UserError('worker bash requires sandbox-exec on Darwin')
    }
    const execPath = system.execPath ?? process.execPath
    return {
      argv: ['sandbox-exec', '-p', darwinProfile(policy, execPath), 'bash', '--noprofile', '--norc', '-c', command],
      wrapped: true,
    }
  }
  if (system.platform === 'linux') {
    if (!system.available('bwrap')) {
      throw new UserError('worker bash requires bubblewrap (bwrap) on Linux')
    }
    const argv = policy.readIsolation
      ? linuxStrictArgv(policy, system.exists ?? existsSync)
      : [
        'bwrap',
        ...(policy.allowNetwork ? [] : ['--unshare-net']),
        ...(policy.unsharePid === true ? ['--unshare-pid'] : []),
        '--ro-bind', '/', '/',
        '--dev', '/dev',
        '--proc', '/proc',
        ...(policy.writableRoots ?? []).flatMap(root => ['--bind', root, root]),
        '--',
      ]
    return {
      argv: [...argv, 'bash', '--noprofile', '--norc', '-c', command],
      wrapped: true,
    }
  }
  throw new UserError(`worker bash has no filesystem sandbox on ${system.platform}`)
}

/** Sandboxing is the default; explicit LocalEnv options can still opt out. */
export function sandboxEnabledFromEnv(_env: NodeJS.ProcessEnv = process.env): boolean {
  return true
}

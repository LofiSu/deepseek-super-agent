import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { LocalEnv, type LocalEnvOptions } from '../src/env/local-env.ts'
import { readIsolationFromEnv, wrapBashCommand, type SandboxPolicy } from '../src/env/seccomp.ts'
import { UserError } from '../src/shared/errors.ts'
import { tempHome } from './fixtures.ts'

const SYSTEM_PATHS = [
  '/System',
  '/usr',
  '/bin',
  '/sbin',
  '/Library',
  '/private/etc',
  // `/etc` is a symlink to `/private/etc` and needs its own read rule.
  '/etc',
  '/private/var/db/dyld',
  '/dev',
  '/private/tmp',
  '/tmp',
  '/var/folders',
  '/private/var/folders',
]

function darwinProfile(policy: SandboxPolicy, execPath = '/opt/node/bin/node'): string {
  const wrapped = wrapBashCommand('echo hi', policy, {
    platform: 'darwin',
    available: () => true,
    execPath,
  })
  expect(wrapped.argv[0]).toBe('sandbox-exec')
  return wrapped.argv[wrapped.argv.indexOf('-p') + 1] ?? ''
}

function linuxArgv(policy: SandboxPolicy, exists: (path: string) => boolean = () => true): string[] {
  return wrapBashCommand('echo hi', policy, {
    platform: 'linux',
    available: bin => bin === 'bwrap',
    exists,
  }).argv
}

describe('strict read isolation (Darwin)', () => {
  it('replaces the host-wide read wildcard with an explicit path allowlist', () => {
    const workspace = '/opt/ds-agent-workspace'
    const profile = darwinProfile({
      enabled: true,
      readIsolation: true,
      writableRoots: [workspace],
      readRoots: ['/opt/extra-tools'],
    })

    expect(profile).not.toContain('(allow file-read*)')
    // The root literal is required for path resolution under strict rules.
    expect(profile).toContain('(allow file-read* (literal "/"))')
    for (const path of SYSTEM_PATHS) {
      expect(profile).toContain(`(allow file-read* (subpath "${path}"))`)
    }
    // Node's own install directory stays readable; a version-manager layout is common.
    expect(profile).toContain('(allow file-read* (subpath "/opt/node/bin"))')
    // Extra opt-in roots are allowed, but the whole home and root are not.
    expect(profile).toContain('(allow file-read* (subpath "/opt/extra-tools"))')
    expect(profile).not.toContain(`(allow file-read* (subpath "${os.homedir()}"))`)
    expect(profile).not.toContain('(allow file-read* (subpath "/"))')
    // The writable root is readable and writable.
    expect(profile).toContain(`(allow file-read* (subpath "${workspace}"))`)
    expect(profile).toContain(`(allow file-write* (subpath "${workspace}"))`)
    // Write, exec, and network rules keep today's shape.
    expect(profile).toContain('(deny default)')
    expect(profile).toContain('(allow process-exec)')
    expect(profile).toContain('(allow process-fork)')
    expect(profile).toContain('(allow sysctl-read)')
    expect(profile).toContain('(allow file-write* (literal "/dev/null"))')
    expect(profile).toContain('(deny network*)')
  })

  it('keeps the wildcard when read isolation is omitted (compatibility)', () => {
    const profile = darwinProfile({ enabled: true, writableRoots: ['/opt/ws'] })
    expect(profile).toContain('(allow file-read*)')
    expect(profile).not.toContain('(allow file-read* (subpath')
    expect(profile).toContain('(deny network*)')
  })

  it('keeps allowNetwork behavior in strict mode', () => {
    const profile = darwinProfile({ enabled: true, readIsolation: true, allowNetwork: true })
    expect(profile).toContain('(allow network*)')
    expect(profile).not.toContain('(deny network*)')
  })
})

const REAL_DARWIN_SANDBOX = process.platform === 'darwin'
  && spawnSync('which', ['sandbox-exec'], { stdio: 'ignore' }).status === 0

/**
 * Generated-profile assertions cannot catch missing SBPL rules. This test runs
 * the real macOS sandbox with strict mode and skips where it is unavailable.
 */
describe.skipIf(!REAL_DARWIN_SANDBOX)('strict read isolation smoke (macOS)', () => {
  it('runs a shell, reads /etc/hosts, and denies reads outside the allowlist', async () => {
    const env = new LocalEnv(tempHome(), {
      timeoutMs: 15_000,
      readIsolation: true,
      env: { PATH: process.env.PATH, HOME: os.homedir() },
      allowlist: ['PATH', 'HOME'],
    })

    const allowed = await env.bash(
      'smoke',
      'echo shell-ok; cat /etc/hosts >/dev/null && echo hosts-ok',
    )
    expect(allowed.code).toBe(0)
    expect(allowed.stdout).toContain('shell-ok')
    expect(allowed.stdout).toContain('hosts-ok')

    // The home directory is deliberately outside the strict allowlist.
    const denied = await env.bash('smoke', 'ls "$HOME"')
    expect(denied.code).not.toBe(0)
    expect(denied.stderr).toMatch(/Operation not permitted|Permission denied/)
  })
})

describe('strict read isolation (Linux)', () => {
  it('drops the root ro-bind and binds only system paths plus the workspace', () => {
    const workspace = '/workspace/worker'
    const argv = linuxArgv({
      enabled: true,
      readIsolation: true,
      writableRoots: [workspace],
      readRoots: ['/opt/extra-tools'],
    })

    expect(argv.join(' ')).not.toContain('--ro-bind / /')
    for (const path of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/private/etc']) {
      expect(argv.join(' ')).toContain(`--ro-bind ${path} ${path}`)
    }
    expect(argv.join(' ')).toContain('--ro-bind /opt/extra-tools /opt/extra-tools')
    expect(argv.join(' ')).toContain('--dev /dev')
    expect(argv.join(' ')).toContain('--proc /proc')
    expect(argv.join(' ')).toContain('--ro-bind /tmp /tmp')
    expect(argv.join(' ')).toContain(`--bind ${workspace} ${workspace}`)
    // Network stays isolated unless explicitly allowed.
    expect(argv).toContain('--unshare-net')
    expect(argv.at(-1)).toBe('echo hi')
  })

  it('omits optional system paths that are not present', () => {
    const argv = linuxArgv(
      { enabled: true, readIsolation: true, writableRoots: ['/workspace'] },
      path => path !== '/private/etc' && path !== '/lib64',
    )
    const joined = argv.join(' ')
    expect(joined).not.toContain('--ro-bind /private/etc /private/etc')
    expect(joined).not.toContain('--ro-bind /lib64 /lib64')
    expect(joined).toContain('--ro-bind /usr /usr')
  })

  it('rejects / and empty writable roots in strict mode', () => {
    expect(() => linuxArgv({ enabled: true, readIsolation: true, writableRoots: ['/'] }))
      .toThrow(UserError)
    expect(() => linuxArgv({ enabled: true, readIsolation: true, writableRoots: [''] }))
      .toThrow(UserError)
    // Non-strict keeps today's behavior and does not add the new rejection.
    expect(() => linuxArgv({ enabled: true, writableRoots: ['/workspace'] })).not.toThrow()
  })

  it('keeps the default argv shape byte-for-byte (compatibility)', () => {
    const argv = linuxArgv({ enabled: true, writableRoots: ['/workspace'] })
    expect(argv).toEqual([
      'bwrap',
      '--unshare-net',
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc',
      '--bind', '/workspace', '/workspace',
      '--',
      'bash', '--noprofile', '--norc', '-c', 'echo hi',
    ])
  })

  it('honors allowNetwork in strict mode', () => {
    const argv = linuxArgv({ enabled: true, readIsolation: true, allowNetwork: true, writableRoots: ['/workspace'] })
    expect(argv).not.toContain('--unshare-net')
  })
})

describe('DS_AGENT_SANDBOX_READ_ISOLATION parsing', () => {
  it('treats unset, empty, 0, and false as off', () => {
    expect(readIsolationFromEnv({})).toBe(false)
    expect(readIsolationFromEnv({ DS_AGENT_SANDBOX_READ_ISOLATION: '' })).toBe(false)
    expect(readIsolationFromEnv({ DS_AGENT_SANDBOX_READ_ISOLATION: '0' })).toBe(false)
    expect(readIsolationFromEnv({ DS_AGENT_SANDBOX_READ_ISOLATION: 'false' })).toBe(false)
  })

  it('treats 1, true, and strict as on', () => {
    expect(readIsolationFromEnv({ DS_AGENT_SANDBOX_READ_ISOLATION: '1' })).toBe(true)
    expect(readIsolationFromEnv({ DS_AGENT_SANDBOX_READ_ISOLATION: 'true' })).toBe(true)
    expect(readIsolationFromEnv({ DS_AGENT_SANDBOX_READ_ISOLATION: 'strict' })).toBe(true)
  })

  it('fails closed on any other value', () => {
    expect(() => readIsolationFromEnv({ DS_AGENT_SANDBOX_READ_ISOLATION: 'yes' })).toThrow(UserError)
    expect(() => readIsolationFromEnv({ DS_AGENT_SANDBOX_READ_ISOLATION: '2' })).toThrow(UserError)
    expect(() => readIsolationFromEnv({ DS_AGENT_SANDBOX_READ_ISOLATION: 'lax' })).toThrow(UserError)
  })
})

describe('LocalEnv read isolation config', () => {
  function envFor(options: LocalEnvOptions): LocalEnv {
    return new LocalEnv(tempHome(), options)
  }

  it('propagates the env switch to the sandbox config', () => {
    const env = envFor({
      sandbox: { enabled: true },
      env: { DS_AGENT_SANDBOX_READ_ISOLATION: 'strict' },
    })
    expect(env.readIsolation).toBe(true)
  })

  it('propagates an explicit option and the sandbox policy flag', () => {
    const fromOption = envFor({ readIsolation: true })
    expect(fromOption.readIsolation).toBe(true)
    const fromPolicy = envFor({ sandbox: { enabled: true, readIsolation: true } })
    expect(fromPolicy.readIsolation).toBe(true)
  })

  it('defaults off and lets an explicit false override the env value', () => {
    expect(envFor({}).readIsolation).toBe(false)
    expect(envFor({
      readIsolation: false,
      env: { DS_AGENT_SANDBOX_READ_ISOLATION: '1' },
    }).readIsolation).toBe(false)
  })

  it('fails closed when the env value is invalid, even with an explicit flag', () => {
    expect(() => envFor({
      readIsolation: true,
      env: { DS_AGENT_SANDBOX_READ_ISOLATION: 'maybe' },
    })).toThrow(UserError)
  })
})

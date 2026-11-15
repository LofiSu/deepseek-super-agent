import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, beforeAll } from 'vitest'
import { LocalEnv } from '../src/env/local-env.ts'
import { UserError } from '../src/shared/errors.ts'
import { bwrapHidePathArgs, wrapBashCommand } from '../src/env/seccomp.ts'
import { tempHome } from './fixtures.ts'

const HAS_BWRAP =
  process.platform === 'linux'
  && spawnSync('which', ['bwrap'], { stdio: 'ignore' }).status === 0

/** Production-like serve options (network off unless env opt-in). */
function prodLikeEnv(root: string, allowNetwork = false): LocalEnv {
  return new LocalEnv(root, {
    timeoutMs: 600_000,
    sandbox: { enabled: true, allowNetwork },
    env: {
      PATH: process.env.PATH,
      DS_AGENT_BASH_ALLOW_NETWORK: allowNetwork ? '1' : '0',
    },
    allowlist: ['PATH', 'HOME', 'TMPDIR', 'DS_AGENT_BASH_ALLOW_NETWORK'],
  })
}

describe.skipIf(!HAS_BWRAP)('LocalEnv dev workspace (Linux bwrap)', () => {
  let outsideTmp: string

  beforeAll(() => {
    outsideTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-outside-ro-'))
  })

  it('sleep 8 succeeds with production-like timeout', async () => {
    const env = prodLikeEnv(tempHome())
    const result = await env.bash('sleep-ok', 'sleep 8 && echo done')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('done')
    expect(result.stderr).not.toContain('[timeout]')
  }, 30_000)

  it('sleep 8 still hits code 124 with default 5s timeout', async () => {
    const env = new LocalEnv(tempHome(), { sandbox: { enabled: true, allowNetwork: false } })
    const result = await env.bash('sleep-fail', 'sleep 8')
    expect(result.code).toBe(124)
    expect(result.stderr).toContain('[timeout]')
  }, 30_000)

  it('creates files in the workspace via bash', async () => {
    const env = prodLikeEnv(tempHome())
    const result = await env.bash('write', 'touch marker.txt && echo hi > marker.txt && cat marker.txt')
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('hi')
    const full = path.join(env.workspace('write'), 'marker.txt')
    expect(fs.readFileSync(full, 'utf8')).toBe('hi\n')
  })

  it('writes under remapped HOME and TMPDIR', async () => {
    const env = prodLikeEnv(tempHome())
    const result = await env.bash(
      'hm',
      'echo home-write > "$HOME/from-home.txt" && echo tmp-write > "$TMPDIR/from-tmp.txt" && cat "$HOME/from-home.txt" "$TMPDIR/from-tmp.txt"',
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('home-write')
    expect(result.stdout).toContain('tmp-write')
    const ws = env.workspace('hm')
    expect(fs.existsSync(path.join(ws, 'from-home.txt'))).toBe(true)
    expect(fs.existsSync(path.join(ws, 'tmp', 'from-tmp.txt'))).toBe(true)
  })

  it('cannot write outside the workspace (host tmp)', async () => {
    const env = prodLikeEnv(tempHome())
    const target = path.join(outsideTmp, 'must-not-exist.txt')
    try {
      fs.unlinkSync(target)
    } catch {
      /* absent */
    }
    const result = await env.bash('ro', `echo pwned > ${JSON.stringify(target)}`)
    expect(result.code).not.toBe(0)
    expect(fs.existsSync(target)).toBe(false)
  })

  it('isolated bash still uses unshare-net', async () => {
    const env = prodLikeEnv(tempHome())
    const cwd = env.isolatedWorkspace('iso')
    const wrapped = wrapBashCommand('true', {
      enabled: true,
      allowNetwork: false,
      writableRoots: [cwd],
    })
    expect(wrapped.argv).toContain('--unshare-net')
    // leavesWorkdir rejects commands with `/`; use getent without path literals.
    const result = await env.bash('iso', 'getent ahosts example.com; echo exit:$?', { isolated: true })
    expect(result.stdout).not.toMatch(/^\d+\.\d+\.\d+\.\d+/m)
    expect(result.stdout).toMatch(/exit:(0|[1-9]\d*)/)
  })

  it('production-like default bwrap argv contains unshare-net', () => {
    const ws = '/tmp/fake-ws'
    const argv = wrapBashCommand('true', {
      enabled: true,
      allowNetwork: false,
      writableRoots: [ws],
    }).argv
    expect(argv).toContain('--unshare-net')
  })

  it('explicit allowNetwork true omits unshare-net', () => {
    const ws = '/tmp/fake-ws'
    const argv = wrapBashCommand('true', {
      enabled: true,
      allowNetwork: true,
      writableRoots: [ws],
    }).argv
    expect(argv).not.toContain('--unshare-net')
  })

  it('hides credential paths with tmpfs in bwrap argv', () => {
    const root = tempHome()
    const hide = path.join(root, 'dummy-creds-dir')
    fs.mkdirSync(hide, { recursive: true })
    const ws = '/tmp/fake-ws2'
    const argv = wrapBashCommand('true', {
      enabled: true,
      allowNetwork: false,
      writableRoots: [ws],
      hidePaths: [hide],
    }, {
      platform: 'linux',
      available: () => true,
    }).argv
    expect(argv).toContain('--tmpfs')
    expect(argv).toContain(hide)
  })

  it('hides credential file with ro-bind dev null in bwrap argv', () => {
    const root = tempHome()
    const hideFile = path.join(root, 'dummy-secret-file')
    fs.writeFileSync(hideFile, 'x')
    const ws = '/tmp/fake-ws3'
    const argv = wrapBashCommand('true', {
      enabled: true,
      allowNetwork: false,
      writableRoots: [ws],
      hidePaths: [hideFile],
    }, {
      platform: 'linux',
      available: () => true,
    }).argv
    expect(argv).toContain('--ro-bind')
    expect(argv).toContain('/dev/null')
    expect(argv).toContain(hideFile)
    expect(bwrapHidePathArgs([hideFile], p => fs.existsSync(p), p => fs.lstatSync(p).isDirectory())).toEqual([
      '--ro-bind', '/dev/null', hideFile,
    ])
  })

  it('credential hide: bash cannot read dummy secret file', async () => {
    const root = tempHome()
    const secretFile = path.join(root, 'fake-netrc-file')
    fs.writeFileSync(secretFile, 'dummy-not-a-real-token\n')
    const env = new LocalEnv(root, {
      timeoutMs: 30_000,
      sandbox: { enabled: true, allowNetwork: false },
      credentialHidePaths: [secretFile],
    })
    const result = await env.bash('hide-file', `cat ${JSON.stringify(secretFile)}; echo exit:$?`)
    expect(result.stdout).toMatch(/exit:(1|[2-9]\d*)/)
    expect(result.stdout).not.toContain('dummy-not-a-real-token')
  })

  it('credential hide: bash cannot read dummy secret path', async () => {
    const root = tempHome()
    const hideDir = path.join(root, 'fake-gh-config')
    fs.mkdirSync(hideDir, { recursive: true })
    const secretFile = path.join(hideDir, 'hosts.yml')
    fs.writeFileSync(secretFile, 'dummy-not-a-real-token')
    const env = new LocalEnv(root, {
      timeoutMs: 30_000,
      sandbox: { enabled: true, allowNetwork: false },
      credentialHidePaths: [hideDir],
    })
    const result = await env.bash('hide', `cat ${JSON.stringify(secretFile)}; echo exit:$?`)
    expect(result.stdout).toMatch(/exit:(1|[2-9]\d*)/)
    expect(result.stdout).not.toContain('dummy-not-a-real-token')
  })

  it('default network off: getent does not resolve public host', async () => {
    const env = prodLikeEnv(tempHome(), false)
    const result = await env.bash('net', 'getent ahosts example.com 2>/dev/null; echo exit:$?')
    expect(result.stdout).not.toMatch(/^\d+\.\d+\.\d+\.\d+/m)
    expect(result.stdout).toMatch(/exit:(0|[1-9]\d*)/)
  })

  it('seeds isolated checkout when sourceRepo is set and workspace is empty', async () => {
    const root = tempHome()
    const seed = path.join(root, 'seed.git')
    execSync(`git init -b main ${JSON.stringify(seed)}`, {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    })
    execSync('git config user.email t@t.com && git config user.name t', { cwd: seed })
    fs.writeFileSync(path.join(seed, 'tracked.txt'), 'seeded\n')
    execSync('git add tracked.txt && git commit -m seed', { cwd: seed })
    const env = new LocalEnv(path.join(root, 'workspaces'), {
      timeoutMs: 60_000,
      sandbox: { enabled: true, allowNetwork: false },
      sourceRepo: seed,
    })
    const worker = env.workspace('clone-me')
    expect(fs.existsSync(path.join(worker, 'tracked.txt'))).toBe(true)
    const common = execSync('git rev-parse --git-common-dir', {
      cwd: worker,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    }).trim()
    const commonAbs = path.resolve(worker, common)
    expect(commonAbs.startsWith(`${fs.realpathSync(worker)}${path.sep}`)).toBe(true)
    const commit = await env.bash(
      'clone-me',
      'git config user.email t@t.com && git config user.name t && '
      + 'git checkout -b peanut/test && echo x >> tracked.txt && git add tracked.txt && git commit -m work',
    )
    expect(commit.code).toBe(0)
  }, 120_000)

  it('rejects git push to main before spawn', async () => {
    const env = prodLikeEnv(tempHome())
    await expect(env.bash('policy', 'git push origin main')).rejects.toThrow(UserError)
  })

  it('rejects gh pr merge before spawn', async () => {
    const env = prodLikeEnv(tempHome())
    await expect(env.bash('policy', 'gh pr merge 1')).rejects.toThrow(UserError)
  })

  it('git push feature branch to local bare remote succeeds', async () => {
    const root = tempHome()
    const env = prodLikeEnv(root, true)
    const ws = env.workspace('git-push')
    const bare = path.join(ws, 'remotes', 'bare.git')
    execSync(`mkdir -p ${JSON.stringify(path.dirname(bare))} && git init --bare ${JSON.stringify(bare)}`, {
      stdio: 'ignore',
    })
    execSync('git init -b feature/writable-test', { cwd: ws, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
    execSync('git config user.email t@t.com && git config user.name t', { cwd: ws })
    execSync('echo x > f && git add f && git commit -m c', { cwd: ws })
    const result = await env.bash('git-push', `git push ${JSON.stringify(bare)} feature/writable-test`)
    expect(result.code).toBe(0)
  })

  it('rejects git push HEAD:main to bare remote', async () => {
    const root = tempHome()
    const env = prodLikeEnv(root, true)
    const ws = env.workspace('git-bad')
    const bare = path.join(ws, 'bare2.git')
    execSync(`git init --bare ${JSON.stringify(bare)}`, { stdio: 'ignore' })
    execSync('git init -b feature/x', { cwd: ws, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
    execSync('git config user.email t@t.com && git config user.name t', { cwd: ws })
    execSync('echo x > f && git add f && git commit -m c', { cwd: ws })
    await expect(env.bash('git-bad', `git push ${JSON.stringify(bare)} HEAD:main`)).rejects.toThrow(UserError)
  })

  it('rejects git push with no refspec when checked out on main', async () => {
    const root = tempHome()
    const env = prodLikeEnv(root, true)
    const ws = env.workspace('main-no-ref')
    const bare = path.join(ws, 'bare.git')
    execSync(`git init --bare ${JSON.stringify(bare)}`, { stdio: 'ignore' })
    execSync('git init -b main', { cwd: ws, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
    execSync(`git remote add origin ${JSON.stringify(bare)}`, { cwd: ws })
    execSync('git config user.email t@t.com && git config user.name t', { cwd: ws })
    execSync('echo x > f && git add f && git commit -m c', { cwd: ws })
    await expect(env.bash('main-no-ref', 'git push origin')).rejects.toThrow(UserError)
  })
})

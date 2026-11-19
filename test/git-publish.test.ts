import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseRepo } from '../src/channels/github-source.ts'
import type { GitRun } from '../src/env/git-publish.ts'
import { FeaturePrPublisher, runGit } from '../src/env/git-publish.ts'
import { UserError } from '../src/shared/errors.ts'
import { tempHome } from './fixtures.ts'

const mockGh = () => vi.fn(async (args: string[]) => {
  if (args[1] === 'list') return '[]'
  if (args[1] === 'create') return 'https://github.com/o/r/pull/42\n'
  if (args[1] === 'view') return JSON.stringify({ number: 42, url: 'https://github.com/o/r/pull/42' })
  return ''
})

function initWorkspace(ws: string, branch: string, bareRemote: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: ws, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
  execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: ws })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: ws })
  fs.writeFileSync(path.join(ws, 'README.md'), 'seed\n')
  execFileSync('git', ['add', 'README.md'], { cwd: ws })
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: ws })
  execFileSync('git', ['checkout', '-b', branch], { cwd: ws })
  fs.appendFileSync(path.join(ws, 'README.md'), 'change\n')
  execFileSync('git', ['add', 'README.md'], { cwd: ws })
  execFileSync('git', ['commit', '-m', 'work'], { cwd: ws })
  execFileSync('git', ['remote', 'add', 'origin', bareRemote], { cwd: ws })
}

function bareFixture(root: string, name = 'remote.git'): string {
  const bare = path.join(root, name)
  execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' })
  return bare
}

function publisher(ws: string, options: { pushRemote?: string; git?: GitRun; gh?: ReturnType<typeof mockGh> } = {}): FeaturePrPublisher {
  return new FeaturePrPublisher({
    repo: parseRepo('o/r'),
    workspace: () => ws,
    ...options,
  })
}

const input = { workerId: 'w1', title: 'My PR', body: 'details' }

describe('FeaturePrPublisher', () => {
  it('imports and pushes the approved commit from a host-owned bare repository', async () => {
    const root = tempHome()
    const bare = bareFixture(root)
    const ws = path.join(root, 'ws')
    fs.mkdirSync(ws)
    initWorkspace(ws, 'peanut/my-feature', bare)
    const gh = mockGh()
    const pub = publisher(ws, { pushRemote: bare, gh })
    const approval = await pub.prepare(input)
    const result = await pub.publish(input, approval)
    const remoteHead = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/peanut/my-feature'], { encoding: 'utf8' }).trim()
    expect(remoteHead).toBe(approval.head)
    expect(result.branch).toBe('peanut/my-feature')
    expect(result.number).toBe(42)
    expect(gh).toHaveBeenCalledWith(expect.arrayContaining(['pr', 'create', '--base', 'main']))
    expect(gh).not.toHaveBeenCalledWith(expect.arrayContaining(['merge']))
  })

  it('does not execute a worker repository pre-push hook', async () => {
    const root = tempHome()
    const bare = bareFixture(root)
    const ws = path.join(root, 'hook-workspace')
    fs.mkdirSync(ws)
    initWorkspace(ws, 'peanut/hook', bare)
    const marker = path.join(root, 'hook-ran')
    const hooks = path.join(ws, '.git', 'hooks')
    fs.mkdirSync(hooks, { recursive: true })
    const hook = path.join(hooks, 'pre-push')
    fs.writeFileSync(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`)
    fs.chmodSync(hook, 0o755)
    const uploadpackHook = path.join(root, 'uploadpack-hook')
    fs.writeFileSync(uploadpackHook, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`)
    fs.chmodSync(uploadpackHook, 0o755)
    execFileSync('git', ['config', 'uploadpack.packObjectsHook', uploadpackHook], { cwd: ws })
    const pub = publisher(ws, { pushRemote: bare, gh: mockGh() })
    const binding = await pub.prepare(input)
    await pub.publish(input, binding)
    expect(fs.existsSync(marker)).toBe(false)
    expect(execFileSync('git', ['--git-dir', bare, 'show-ref', '--verify', 'refs/heads/peanut/hook'], { encoding: 'utf8' })).toContain(binding.head)
  })

  it('ignores worker insteadOf config when selecting the effective push destination', async () => {
    const root = tempHome()
    const intended = bareFixture(root, 'intended.git')
    const redirect = bareFixture(root, 'redirect.git')
    const ws = path.join(root, 'redirect-workspace')
    fs.mkdirSync(ws)
    initWorkspace(ws, 'peanut/fixed', intended)
    execFileSync('git', ['config', `url.${redirect}.insteadOf`, 'https://github.com/o/r.git'], { cwd: ws })
    const mappedGit: GitRun = (args, opts) => {
      const mapped = [...args]
      if (mapped[0] === 'push') {
        const remoteIndex = mapped.findIndex(arg => arg === 'https://github.com/o/r.git')
        if (remoteIndex >= 0) mapped[remoteIndex] = intended
      }
      return runGit(mapped, opts)
    }
    const pub = publisher(ws, { git: mappedGit, gh: mockGh() })
    const binding = await pub.prepare(input)
    await pub.publish(input, binding)
    expect(execFileSync('git', ['--git-dir', intended, 'rev-parse', 'refs/heads/peanut/fixed'], { encoding: 'utf8' }).trim()).toBe(binding.head)
    expect(() => execFileSync('git', ['--git-dir', redirect, 'show-ref', '--verify', 'refs/heads/peanut/fixed'])).toThrow()
  })

  it('refuses publishing if the approved binding no longer matches current metadata', async () => {
    const root = tempHome()
    const bare = bareFixture(root)
    const ws = path.join(root, 'mismatch')
    fs.mkdirSync(ws)
    initWorkspace(ws, 'peanut/mismatch', bare)
    const gh = mockGh()
    const pub = publisher(ws, { pushRemote: bare, gh })
    const binding = await pub.prepare(input)
    await expect(pub.publish({ ...input, body: 'changed after approval' }, binding)).rejects.toThrow(/approval does not match/)
    expect(gh).not.toHaveBeenCalled()
    expect(() => execFileSync('git', ['--git-dir', bare, 'show-ref', '--verify', 'refs/heads/peanut/mismatch'])).toThrow()
  })

  it('refuses protected or invalid branches before host publication', async () => {
    const root = tempHome()
    const bare = bareFixture(root)
    const ws = path.join(root, 'bad-branch')
    fs.mkdirSync(ws)
    initWorkspace(ws, 'peanut/ok', bare)
    const pub = publisher(ws, { pushRemote: bare, gh: mockGh() })
    await expect(pub.prepare({ ...input, branch: 'main' })).rejects.toThrow(UserError)
    await expect(pub.prepare({ ...input, branch: 'foo:main' })).rejects.toThrow(UserError)
  })

  it('updates an existing open PR only after matching approval', async () => {
    const root = tempHome()
    const bare = bareFixture(root)
    const ws = path.join(root, 'existing')
    fs.mkdirSync(ws)
    initWorkspace(ws, 'peanut/exist', bare)
    const gh = vi.fn(async (args: string[]) => {
      if (args[1] === 'list') return JSON.stringify([{ number: 7, url: 'https://github.com/o/r/pull/7' }])
      return ''
    })
    const pub = publisher(ws, { pushRemote: bare, gh })
    const binding = await pub.prepare(input)
    const result = await pub.publish(input, binding)
    expect(result.number).toBe(7)
    expect(gh).toHaveBeenCalledWith(expect.arrayContaining(['pr', 'edit', '7']))
    expect(gh).not.toHaveBeenCalledWith(expect.arrayContaining(['pr', 'create']))
  })
})

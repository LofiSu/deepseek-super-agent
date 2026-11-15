import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseRepo } from '../src/channels/github-source.ts'
import type { GitRun } from '../src/env/git-publish.ts'
import { FeaturePrPublisher } from '../src/env/git-publish.ts'
import { UserError } from '../src/shared/errors.ts'
import { tempHome } from './fixtures.ts'

const mockGh = () => vi.fn(async (args: string[]) => {
  if (args[1] === 'list') return '[]'
  if (args[1] === 'create') return 'https://github.com/o/r/pull/42\n'
  if (args[1] === 'view') return JSON.stringify({ number: 42, url: 'https://github.com/o/r/pull/42' })
  if (args[1] === 'edit') return ''
  return ''
})

function initWorkspace(
  ws: string,
  branch: string,
  bareRemote: string,
): void {
  execSync('git init -b main', {
    cwd: ws,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  })
  execSync('git config user.email t@t.com && git config user.name t', { cwd: ws })
  fs.writeFileSync(path.join(ws, 'README.md'), 'seed\n')
  execSync('git add README.md && git commit -m seed', { cwd: ws })
  execSync(`git checkout -b ${branch}`, { cwd: ws })
  fs.appendFileSync(path.join(ws, 'README.md'), 'change\n')
  execSync('git add README.md && git commit -m work', { cwd: ws })
  execSync(`git remote add origin ${JSON.stringify(bareRemote)}`, { cwd: ws })
}

function bareFixture(root: string): { bare: string; mainBefore: string } {
  const bare = path.join(root, 'remote.git')
  execSync(`git init --bare -b main ${JSON.stringify(bare)}`, { stdio: 'ignore' })
  const probe = path.join(root, 'probe')
  fs.mkdirSync(probe)
  execSync('git init -b main', { cwd: probe, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
  execSync('git config user.email t@t.com && git config user.name t', { cwd: probe })
  fs.writeFileSync(path.join(probe, 'f'), 'main\n')
  execSync('git add f && git commit -m main', { cwd: probe })
  execSync(`git push ${JSON.stringify(bare)} main`, { cwd: probe })
  const mainBefore = execSync(`git -C ${JSON.stringify(bare)} rev-parse refs/heads/main`, {
    encoding: 'utf8',
  }).trim()
  return { bare, mainBefore }
}

describe('FeaturePrPublisher', () => {
  it('pushes peanut/ branch and opens a PR to main', async () => {
    const root = tempHome()
    const { bare, mainBefore } = bareFixture(root)
    const ws = path.join(root, 'ws')
    fs.mkdirSync(ws)
    initWorkspace(ws, 'peanut/my-feature', bare)
    const ghCalls: string[][] = []
    const gh = vi.fn(async (args: string[]) => {
      ghCalls.push([...args])
      if (args[1] === 'list') return '[]'
      if (args[1] === 'create') return 'https://github.com/o/r/pull/42\n'
      if (args[1] === 'view') return JSON.stringify({ number: 42, url: 'https://github.com/o/r/pull/42' })
      return ''
    })
    const gitReal = await import('../src/env/git-publish.ts')
    const pub = new FeaturePrPublisher({
      repo: parseRepo('o/r'),
      workspace: () => ws,
      pushRemote: bare,
      git: gitReal.runGit,
      gh,
    })
    const result = await pub.publish({
      workerId: 'w1',
      title: 'My PR',
      body: 'details',
    })
    expect(result.branch).toBe('peanut/my-feature')
    expect(result.number).toBe(42)
    expect(result.url).toContain('/pull/42')
    const remoteHead = execSync(`git -C ${JSON.stringify(bare)} rev-parse refs/heads/peanut/my-feature`, {
      encoding: 'utf8',
    }).trim()
    expect(remoteHead).toBeTruthy()
    const mainAfter = execSync(`git -C ${JSON.stringify(bare)} rev-parse refs/heads/main`, { encoding: 'utf8' }).trim()
    expect(mainAfter).toBe(mainBefore)
    expect(ghCalls.some(a => a[0] === 'pr' && a[1] === 'create' && a.includes('main'))).toBe(true)
    expect(ghCalls.some(a => a.includes('merge'))).toBe(false)
  })

  it('updates an existing open PR', async () => {
    const root = tempHome()
    const { bare } = bareFixture(root)
    const ws = path.join(root, 'ws2')
    fs.mkdirSync(ws)
    initWorkspace(ws, 'peanut/exist', bare)
    const gh = vi.fn(async (args: string[]) => {
      if (args[1] === 'list') {
        return JSON.stringify([{ number: 7, url: 'https://github.com/o/r/pull/7' }])
      }
      if (args[1] === 'edit') return ''
      return ''
    })
    const gitReal = await import('../src/env/git-publish.ts')
    const pub = new FeaturePrPublisher({
      repo: parseRepo('o/r'),
      workspace: () => ws,
      pushRemote: bare,
      git: gitReal.runGit,
      gh,
    })
    const result = await pub.publish({ workerId: 'w', title: 'Updated' })
    expect(result.number).toBe(7)
    expect(gh).toHaveBeenCalledWith(expect.arrayContaining(['pr', 'edit', '7']))
    expect(gh).not.toHaveBeenCalledWith(expect.arrayContaining(['pr', 'create']))
  })

  it('refuses workspace whose gitdir is outside', async () => {
    const root = tempHome()
    const outer = path.join(root, 'outer.git')
    const ws = path.join(root, 'linked')
    execSync(`git init --bare -b main ${JSON.stringify(outer)}`, { stdio: 'ignore' })
    fs.mkdirSync(ws)
    fs.writeFileSync(path.join(ws, '.git'), `gitdir: ${outer}\n`)
    const gh = mockGh()
    const pub = new FeaturePrPublisher({
      repo: parseRepo('o/r'),
      workspace: () => ws,
      gh,
    })
    await expect(pub.publish({ workerId: 'w', title: 't' })).rejects.toThrow(UserError)
    expect(gh).not.toHaveBeenCalled()
  })

  it('refuses protected branch slug', async () => {
    const root = tempHome()
    const { bare } = bareFixture(root)
    const ws = path.join(root, 'bad-slug')
    fs.mkdirSync(ws)
    initWorkspace(ws, 'peanut/ok', bare)
    const gh = mockGh()
    const git = vi.fn<GitRun>(async () => ({ code: 0, stdout: '', stderr: '' }))
    const pub = new FeaturePrPublisher({
      repo: parseRepo('o/r'),
      workspace: () => ws,
      pushRemote: bare,
      git,
      gh,
    })
    await expect(
      pub.publish({ workerId: 'w', title: 't', branch: 'main' }),
    ).rejects.toThrow(UserError)
    expect(gh).not.toHaveBeenCalled()
    expect(git).not.toHaveBeenCalled()
  })

  it.each(['foo:main', '--force', 'has space'])('refuses branch slug %s', async slug => {
    const root = tempHome()
    const { bare } = bareFixture(root)
    const ws = path.join(root, `slug-${slug.replace(/\W/g, '_')}`)
    fs.mkdirSync(ws)
    initWorkspace(ws, 'peanut/ok', bare)
    const gh = mockGh()
    const pub = new FeaturePrPublisher({
      repo: parseRepo('o/r'),
      workspace: () => ws,
      pushRemote: bare,
      git: async () => ({ code: 0, stdout: '', stderr: '' }),
      gh,
    })
    await expect(pub.publish({ workerId: 'w', title: 't', branch: slug })).rejects.toThrow(UserError)
    expect(gh).not.toHaveBeenCalled()
  })

  it('pushes to fixed GitHub URL, not workspace origin', async () => {
    const root = tempHome()
    const { bare } = bareFixture(root)
    const ws = path.join(root, 'fixed-push')
    fs.mkdirSync(ws)
    initWorkspace(ws, 'peanut/fixed', bare)
    execSync('git remote set-url origin https://evil.example/oops.git', { cwd: ws })
    const pushed: string[][] = []
    const git: GitRun = async (args, _opts) => {
      pushed.push(args)
      return { code: 0, stdout: '', stderr: '' }
    }
    const gh = mockGh()
    const pub = new FeaturePrPublisher({
      repo: parseRepo('o/r'),
      workspace: () => ws,
      git,
      gh,
    })
    await pub.publish({ workerId: 'w', title: 't' })
    const pushArgs = pushed.find(a => a[0] === 'push')!
    expect(pushArgs[1]).toBe('https://github.com/o/r.git')
    expect(pushArgs[1]).not.toContain('evil.example')
    expect(pushArgs[1]).not.toBe('origin')
  })

  it('git push argv never includes force or tags', async () => {
    const root = tempHome()
    const { bare } = bareFixture(root)
    const ws = path.join(root, 'argv')
    fs.mkdirSync(ws)
    initWorkspace(ws, 'peanut/x', bare)
    const pushed: string[][] = []
    const git: GitRun = async (args, opts) => {
      pushed.push(args)
      const real = await import('../src/env/git-publish.ts')
      return real.runGit(args, opts)
    }
    const gh = mockGh()
    const pub = new FeaturePrPublisher({
      repo: parseRepo('o/r'),
      workspace: () => ws,
      pushRemote: bare,
      git,
      gh,
    })
    await pub.publish({ workerId: 'w', title: 't' })
    const pushArgs = pushed.find(a => a[0] === 'push')!
    expect(pushArgs).toBeDefined()
    const pushText = pushArgs.join(' ')
    expect(pushText).not.toMatch(/force|--tags/)
    expect(pushText).not.toMatch(/HEAD:main|:\s*main|refs\/heads\/main/)
    expect(pushArgs).toContain('HEAD:peanut/x')
  })
})


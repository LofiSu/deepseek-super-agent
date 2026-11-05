import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { LocalEnv } from '../src/env/local-env.ts'

const roots: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), prefix))
  roots.push(dir)
  return dir
}

function setup(): { root: string; outside: string; env: LocalEnv } {
  const root = tempDir('ds-env-root-')
  return { root, outside: tempDir('ds-env-outside-'), env: new LocalEnv(root, { env: {} }) }
}

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('LocalEnv path containment', () => {
  it('refuses to write through a symlink to a file outside the workspace', async () => {
    const { env, outside } = setup()
    const victim = path.join(outside, 'victim.txt')
    fs.writeFileSync(victim, 'original')
    fs.symlinkSync(victim, path.join(env.workspace('w1'), 'link.txt'))

    await expect(env.writeFile('w1', 'link.txt', 'pwned')).rejects.toThrow(/symlink/)
    expect(fs.readFileSync(victim, 'utf8')).toBe('original')
  })

  it('refuses to create directories through a symlinked directory', async () => {
    const { env, outside } = setup()
    fs.symlinkSync(outside, path.join(env.workspace('w1'), 'dir'))

    await expect(env.writeFile('w1', 'dir/new/file.txt', 'pwned')).rejects.toThrow(/symlink/)
    expect(fs.existsSync(path.join(outside, 'new'))).toBe(false)
  })

  it('refuses to read through a symlink outside the workspace', async () => {
    const { env, outside } = setup()
    const secret = path.join(outside, 'secret.txt')
    fs.writeFileSync(secret, 'secret')
    fs.symlinkSync(secret, path.join(env.workspace('w1'), 'read-link.txt'))

    await expect(env.readFile('w1', 'read-link.txt')).rejects.toThrow(/symlink/)
  })

  it('refuses a broken symlink instead of following or creating through it', async () => {
    const { env, outside } = setup()
    const missing = path.join(outside, 'missing.txt')
    fs.symlinkSync(missing, path.join(env.workspace('w1'), 'broken.txt'))

    await expect(env.writeFile('w1', 'broken.txt', 'pwned')).rejects.toThrow(/symlink/)
    expect(fs.existsSync(missing)).toBe(false)
  })

  it('applies the same no-symlink rule to links that resolve inside the workspace', async () => {
    const { env } = setup()
    const dir = env.workspace('w1')
    fs.writeFileSync(path.join(dir, 'real.txt'), 'hello')
    fs.symlinkSync(path.join(dir, 'real.txt'), path.join(dir, 'inner-link.txt'))

    await expect(env.readFile('w1', 'inner-link.txt')).rejects.toThrow(/symlink/)
    await expect(env.writeFile('w1', 'inner-link.txt', 'pwned')).rejects.toThrow(/symlink/)
    expect(fs.readFileSync(path.join(dir, 'real.txt'), 'utf8')).toBe('hello')
  })

  it('maps a self-referential link to a workspace error instead of a raw ELOOP', async () => {
    const { env } = setup()
    const dir = env.workspace('w1')
    fs.symlinkSync(path.join(dir, 'self.txt'), path.join(dir, 'self.txt'))

    await expect(env.readFile('w1', 'self.txt')).rejects.toThrow(/symlink/)
    await expect(env.writeFile('w1', 'self.txt', 'x')).rejects.toThrow(/symlink/)
  })

  it('still writes and reads ordinary nested workspace files', async () => {
    const { env } = setup()
    await env.writeFile('w1', 'notes/today.txt', 'hello')
    expect(await env.readFile('w1', 'notes/today.txt')).toBe('hello')
  })
})

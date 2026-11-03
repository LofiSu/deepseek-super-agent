import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { wireConfig, readConfig } from '../src/gateway/wiring.ts'
import { deleteProfile, listProfiles, loadProfile, saveProfile } from '../src/gateway/profiles.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

function tempFile(name: string, body?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-wire-'))
  cleanup.push(async () => { fs.rmSync(dir, { recursive: true, force: true }) })
  const file = path.join(dir, name)
  if (body !== undefined) fs.writeFileSync(file, body)
  return file
}

describe('agent config wiring', () => {
  it('merges top-level JSON keys and keeps unrelated ones', () => {
    const file = tempFile('settings.json', '{"keep":1}')
    wireConfig(file, { A: '1' })
    wireConfig(file, { B: '2' })
    const config = readConfig(file)
    expect(config).toMatchObject({ keep: 1, A: '1', B: '2' })
  })

  it('writes JSON under env when envScope is set', () => {
    const file = tempFile('settings.json', '{}')
    wireConfig(file, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4319' }, { envScope: true })
    const config = readConfig(file) as { env: Record<string, string> }
    expect(config.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:4319')
  })

  it('rewrites matching env lines without duplicating keys', () => {
    const file = tempFile('agent.env', 'OLD=1\nKEEP=2\n')
    wireConfig(file, { OLD: '9', NEW: '3' })
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toContain('OLD=9')
    expect(lines).toContain('KEEP=2')
    expect(lines).toContain('NEW=3')
    expect(lines.filter(line => line.startsWith('OLD='))).toHaveLength(1)
  })
})

describe('gateway profiles', () => {
  it('saves, lists, loads and deletes profiles', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-prof-'))
    cleanup.push(async () => { fs.rmSync(home, { recursive: true, force: true }) })
    saveProfile(home, 'work', { providers: [{ id: 'x', baseUrl: 'http://x' }], defaultModel: 'm1' })
    expect(listProfiles(home).map(profile => profile.name)).toEqual(['work'])
    expect(loadProfile(home, 'work')?.defaultModel).toBe('m1')
    expect(deleteProfile(home, 'work')).toBe(true)
    expect(listProfiles(home)).toEqual([])
  })
})

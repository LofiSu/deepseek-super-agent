import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  FillVault,
  ProcessFillTarget,
  fillAction,
  fillVaultPath,
  loadFillVault,
  type FillField,
  type FillTarget,
} from '../src/env/fill-vault.ts'
import { LocalEnv } from '../src/env/local-env.ts'

const dirs: string[] = []

function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-fill-'))
  dirs.push(dir)
  return dir
}

function writeVault(dir: string, doc: unknown, mode = 0o600): string {
  const file = path.join(dir, 'vault.json')
  fs.writeFileSync(file, JSON.stringify(doc), { mode })
  fs.chmodSync(file, mode)
  return file
}

class RecordingTarget implements FillTarget {
  readonly label = 'test-form'
  readonly writes: { field: FillField; value: string }[] = []

  fill(field: FillField, value: string): void {
    this.writes.push({ field, value })
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('fill-only vault', () => {
  it('is unavailable when the config is missing', () => {
    const dir = home()
    const result = loadFillVault(path.join(dir, 'vault.json'))
    expect(result.vault).toBeUndefined()
    expect(result.reason).toBe('missing')
  })

  it('fails closed on a group/world-readable config', () => {
    const dir = home()
    const file = writeVault(dir, {
      fill: { login: { kind: 'password', password: 'secret-password-value' } },
    }, 0o644)
    const strict = loadFillVault(file)
    expect(strict.vault).toBeUndefined()
    expect(strict.reason).toBe('insecure-mode')
    const relaxed = loadFillVault(file, { requirePrivateFile: false })
    expect(relaxed.vault?.summary()).toEqual([
      { name: 'login', kind: 'password', fields: ['password'] },
    ])
  })

  it('lists names, kinds, and fields without values', () => {
    const dir = home()
    const file = writeVault(dir, {
      fill: {
        login: { kind: 'password', username: 'owner@example.com', password: 'secret-password-value' },
        visa: { kind: 'card', number: '4111111111111111', expiry: '12/29', cvc: '123' },
      },
    })
    const { vault } = loadFillVault(file)
    expect(vault).toBeDefined()
    const serialized = JSON.stringify(vault!.summary())
    expect(serialized).not.toContain('secret-password-value')
    expect(serialized).not.toContain('4111111111111111')
    expect(serialized).not.toContain('123')
    expect(vault!.summary()).toEqual([
      { name: 'login', kind: 'password', fields: ['username', 'password'] },
      { name: 'visa', kind: 'card', fields: ['number', 'expiry', 'cvc'] },
    ])
  })

  it('fills a password into the adapter and returns only a receipt', async () => {
    const dir = home()
    const file = writeVault(dir, {
      fill: { login: { kind: 'password', password: 'secret-password-value' } },
    })
    const { vault } = loadFillVault(file)
    const target = new RecordingTarget()
    const receipt = await vault!.fill({ entry: 'login', target })

    expect(target.writes).toEqual([{ field: 'password', value: 'secret-password-value' }])
    expect(receipt).toMatchObject({
      entry: 'login',
      kind: 'password',
      target: 'test-form',
      fields: ['password'],
    })
    expect(JSON.stringify(receipt)).not.toContain('secret-password-value')
  })

  it('fills only the requested card fields and never invents an absent one', async () => {
    const dir = home()
    const file = writeVault(dir, {
      fill: { visa: { kind: 'card', number: '4111111111111111', expiry: '12/29' } },
    })
    const { vault } = loadFillVault(file)
    const target = new RecordingTarget()
    const receipt = await vault!.fill({ entry: 'visa', target, fields: ['expiry'] })

    expect(target.writes).toEqual([{ field: 'expiry', value: '12/29' }])
    expect(receipt.fields).toEqual(['expiry'])
    await expect(vault!.fill({ entry: 'visa', target, fields: ['cvc'] }))
      .rejects.toThrow(/has no cvc field/)
  })

  it('rejects an unknown entry without echoing a value', async () => {
    const dir = home()
    const file = writeVault(dir, {
      fill: { login: { kind: 'password', password: 'secret-password-value' } },
    })
    const { vault } = loadFillVault(file)
    const target = new RecordingTarget()
    await expect(vault!.fill({ entry: 'missing', target })).rejects.toThrow(/unknown vault entry/)
    try {
      await vault!.fill({ entry: 'missing', target })
    } catch (error) {
      expect(String(error)).not.toContain('secret-password-value')
    }
  })

  it('rejects malformed or empty fill configs', () => {
    const dir = home()
    const malformed = writeVault(dir, { fill: { login: { kind: 'password' } } })
    expect(loadFillVault(malformed)).toMatchObject({ reason: 'invalid' })
    const empty = writeVault(dir, { fill: {} })
    expect(loadFillVault(empty)).toMatchObject({ reason: 'no-fill-entries' })
    const flat = writeVault(dir, { TOKEN: 'env-secret-value' })
    expect(loadFillVault(flat)).toMatchObject({ reason: 'no-fill-entries' })
  })

  it('defaults the path to vault.json and honours DS_AGENT_VAULT_FILE', () => {
    const dir = home()
    expect(fillVaultPath(dir, {})).toBe(path.join(dir, 'vault.json'))
    expect(fillVaultPath(dir, { DS_AGENT_VAULT_FILE: '/tmp/other.json' })).toBe('/tmp/other.json')
  })

  it('builds a stable, bounded action text', () => {
    const action = fillAction({
      entry: 'visa',
      kind: 'card',
      target: 'browser:checkout.example',
      fields: ['number', 'expiry'],
    })
    expect(action).toBe('Fill card "visa" into form "browser:checkout.example" (number, expiry)')
    expect(fillAction({
      entry: 'login',
      kind: 'password',
      target: 'browser:app.example',
      fields: ['password'],
    })).toBe('Fill credential "login" into form "browser:app.example" (password)')
  })

  it('hands a value to a local helper over stdin, never argv, and redacts failure output', async () => {
    const dir = home()
    const marker = path.join(dir, 'marker.json')
    const target = new ProcessFillTarget({
      command: process.execPath,
      args: ['-e', `const fs=require('fs');let s='';process.stdin.on('data',d=>s+=d).on('end',()=>fs.writeFileSync(${JSON.stringify(marker)},s))`],
      label: 'helper',
      timeoutMs: 5_000,
    })
    await target.fill('password', 'stdin-only-value')
    expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toEqual({
      field: 'password',
      value: 'stdin-only-value',
    })

    const failing = new ProcessFillTarget({
      command: process.execPath,
      args: ['-e', `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.error(s);process.exit(3)})`],
      label: 'failing-helper',
      timeoutMs: 5_000,
    })
    let message = ''
    try {
      await failing.fill('password', 'stdin-only-value')
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain('exit 3')
    expect(message).not.toContain('stdin-only-value')
  })

  it('redacts short vault values from a worker shell even if the file is readable', async () => {
    const dir = home()
    const file = writeVault(dir, {
      fill: { card: { kind: 'card', number: '4111111111111111', cvc: '987' } },
    })
    const { vault } = loadFillVault(file)
    const env = new LocalEnv(path.join(dir, 'workspaces'), {
      env: { PATH: process.env.PATH },
      sandbox: { enabled: false },
      redactValues: vault!.redactionValues(),
    })
    const result = await env.bash('w1', `cat ${file}`)
    expect(result.stdout).not.toContain('4111111111111111')
    expect(result.stdout).not.toContain('987')
    expect(result.stdout).toContain('[redacted]')
  })

  it('parses a document for an embedding app without exposing values in summaries', () => {
    const vault = FillVault.fromDocument({
      fill: { login: { kind: 'password', password: 'another-secret-value' } },
    })
    expect(vault.summary()).toEqual([{ name: 'login', kind: 'password', fields: ['password'] }])
    expect(JSON.stringify(vault.summary())).not.toContain('another-secret-value')
  })
})

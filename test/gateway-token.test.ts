import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  GatewayTokenFileError,
  gatewayTokenPath,
  loadOrCreateGatewayToken,
  readGatewayToken,
} from '../src/gateway/token.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanup.length > 0) await cleanup.pop()!()
})

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-token-'))
  cleanup.push(async () => { fs.rmSync(home, { recursive: true, force: true }) })
  return home
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

describe('gateway token file races', () => {
  it('fails closed instead of returning a token when a concurrent create leaves the file empty', () => {
    const home = tempHome()
    const file = gatewayTokenPath(home)
    fs.writeFileSync(file, '', { mode: 0o600 })
    fs.chmodSync(file, 0o600)

    let returned: string | undefined
    expect(() => { returned = loadOrCreateGatewayToken(home) }).toThrow(GatewayTokenFileError)
    expect(() => loadOrCreateGatewayToken(home)).toThrow(/concurrent|empty/i)
    expect(returned).toBeUndefined()
    // Never overwrite the winner's still-in-progress file with our own token.
    expect(fs.readFileSync(file, 'utf8')).toBe('')
  })

  it('reuses the token persisted by the concurrent create winner', () => {
    const home = tempHome()
    const file = gatewayTokenPath(home)
    fs.writeFileSync(file, 'gw_racedwinner\n', { mode: 0o600 })
    fs.chmodSync(file, 0o600)

    expect(loadOrCreateGatewayToken(home)).toBe('gw_racedwinner')
    expect(fs.readFileSync(file, 'utf8')).toBe('gw_racedwinner\n')
  })

  it('fails closed when the path becomes a symlink between lstat and open (ELOOP)', () => {
    const home = tempHome()
    const file = gatewayTokenPath(home)
    fs.writeFileSync(file, 'gw_existing\n', { mode: 0o600 })
    fs.chmodSync(file, 0o600)

    const loop = errno('ELOOP', 'ELOOP: too many levels of symbolic links')
    const open = vi.spyOn(fs, 'openSync').mockImplementation(() => { throw loop })
    try {
      let returned: string | undefined
      expect(() => { returned = readGatewayToken(home) }).toThrow(GatewayTokenFileError)
      expect(() => readGatewayToken(home)).toThrow(/changed while being opened|ELOOP/i)
      expect(returned).toBeUndefined()
      expect(() => loadOrCreateGatewayToken(home)).toThrow(GatewayTokenFileError)
    } finally {
      open.mockRestore()
    }
  })
})

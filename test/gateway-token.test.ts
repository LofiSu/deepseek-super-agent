import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createModelFromEnv, HttpOpenAI, MockModel } from '../src/harness/model.ts'
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

function gatewayEnv(home: string): NodeJS.ProcessEnv {
  return { DS_AGENT_GATEWAY_URL: 'http://127.0.0.1:9', DS_AGENT_HOME: home } as NodeJS.ProcessEnv
}

function captureThrow(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

describe('stale empty gateway token file', () => {
  function expectStaleEmpty(content: string): void {
    const home = tempHome()
    const file = gatewayTokenPath(home)
    fs.writeFileSync(file, content, { mode: 0o600 })
    fs.chmodSync(file, 0o600)
    // Loosen first so the POSIX mode check has something to tighten; the
    // failing path must never loosen it.
    if (process.platform !== 'win32') fs.chmodSync(file, 0o644)
    const before = fs.statSync(file)

    for (const run of [() => readGatewayToken(home), () => loadOrCreateGatewayToken(home)]) {
      const error = captureThrow(run)
      expect(error).toBeInstanceOf(GatewayTokenFileError)
      const message = (error as Error).message
      expect(message).toContain(file)
      expect(message).toMatch(/is empty \(zero-length or whitespace-only\)/)
      expect(message).toMatch(/remove it to mint a new token/)
      // The misleading concurrent-create message belongs to the real race only.
      expect(message).not.toMatch(/concurrent/i)
    }

    const after = fs.statSync(file)
    // No delete/rename/recreate and no token minted over the evidence.
    expect(after.ino).toBe(before.ino)
    expect(fs.readFileSync(file, 'utf8')).toBe(content)
    // The existing security check may tighten, never loosen.
    if (process.platform !== 'win32') expect(after.mode & 0o777).toBe(0o600)
  }

  it('reports a zero-length file as stale-empty and leaves it untouched', () => {
    expectStaleEmpty('')
  })

  it('reports a whitespace-only file as stale-empty and leaves it untouched', () => {
    expectStaleEmpty(' \n\t \n')
  })

  it('fails closed on the client read path instead of falling back to another provider', () => {
    const home = tempHome()
    const file = gatewayTokenPath(home)
    fs.writeFileSync(file, '', { mode: 0o600 })
    fs.chmodSync(file, 0o600)

    const error = captureThrow(() => createModelFromEnv(gatewayEnv(home)))
    expect(error).toBeInstanceOf(GatewayTokenFileError)
    expect((error as Error).message).toMatch(/is empty \(zero-length or whitespace-only\)/)
    expect(fs.readFileSync(file, 'utf8')).toBe('')
  })

  it('still uses a valid persisted token for the client path', () => {
    const home = tempHome()
    const file = gatewayTokenPath(home)
    fs.writeFileSync(file, 'gw_valid\n', { mode: 0o600 })
    fs.chmodSync(file, 0o600)

    expect(createModelFromEnv(gatewayEnv(home))).toBeInstanceOf(HttpOpenAI)
  })

  it('keeps the absent-file fallback for the client path', () => {
    const home = tempHome()
    expect(fs.existsSync(gatewayTokenPath(home))).toBe(false)
    expect(createModelFromEnv(gatewayEnv(home))).toBeInstanceOf(MockModel)
  })

  it('honors an explicit client token without reading the empty file', () => {
    const home = tempHome()
    const file = gatewayTokenPath(home)
    fs.writeFileSync(file, '\n', { mode: 0o600 })
    fs.chmodSync(file, 0o600)

    const env = { ...gatewayEnv(home), DS_AGENT_GATEWAY_TOKEN: ' gw_explicit ' } as NodeJS.ProcessEnv
    expect(createModelFromEnv(env)).toBeInstanceOf(HttpOpenAI)
    expect(fs.readFileSync(file, 'utf8')).toBe('\n')
  })

  it('honors an explicit override without touching an empty file', () => {
    const home = tempHome()
    const file = gatewayTokenPath(home)
    fs.writeFileSync(file, '  \n', { mode: 0o600 })
    fs.chmodSync(file, 0o600)
    const before = fs.statSync(file)

    expect(loadOrCreateGatewayToken(home, 'explicit-token')).toBe('explicit-token')
    const after = fs.statSync(file)
    expect(after.ino).toBe(before.ino)
    expect(fs.readFileSync(file, 'utf8')).toBe('  \n')
  })
})

describe('gateway token file races', () => {
  it('fails closed instead of returning a token when a concurrent create leaves the file empty', () => {
    const home = tempHome()
    const file = gatewayTokenPath(home)
    // The first read sees no file. Between that read and our exclusive create
    // another process wins the race, publishes an empty file (it may still be
    // writing), and our create fails with EEXIST.
    const realOpenSync = fs.openSync.bind(fs)
    const open = vi.spyOn(fs, 'openSync').mockImplementation(((
      target: fs.PathLike,
      flags: fs.OpenMode,
      mode?: fs.Mode,
    ): number => {
      if (typeof flags === 'number' && (flags & fs.constants.O_EXCL) !== 0) {
        fs.writeFileSync(target, '', { mode: 0o600 })
        fs.chmodSync(target, 0o600)
        throw errno('EEXIST', 'EEXIST: file already exists, open for exclusive create')
      }
      return realOpenSync(target, flags, mode)
    }) as typeof fs.openSync)

    try {
      expect(fs.existsSync(file)).toBe(false)
      const error = captureThrow(() => loadOrCreateGatewayToken(home))
      expect(error).toBeInstanceOf(GatewayTokenFileError)
      const message = (error as Error).message
      expect(message).toMatch(/was created concurrently and is empty/)
      // The stale-file diagnostic is reserved for a file that existed before
      // the initial read; this is the genuine create race.
      expect(message).not.toMatch(/remove it to mint a new token/)
      // Never overwrite the winner's still-in-progress file with our own token.
      expect(fs.readFileSync(file, 'utf8')).toBe('')
    } finally {
      open.mockRestore()
    }
  })

  it('reuses the token persisted by the concurrent create winner', () => {
    const home = tempHome()
    const file = gatewayTokenPath(home)
    fs.writeFileSync(file, 'gw_racedwinner\n', { mode: 0o600 })
    fs.chmodSync(file, 0o600)

    expect(loadOrCreateGatewayToken(home)).toBe('gw_racedwinner')
    expect(fs.readFileSync(file, 'utf8')).toBe('gw_racedwinner\n')
  })

  it('reuses the winner token when the O_EXCL create loses an EEXIST race', () => {
    const home = tempHome()
    const file = gatewayTokenPath(home)
    // The first read sees no file. Between that read and our exclusive create
    // another process wins the race and publishes its token, so our create
    // fails with EEXIST even though the initial read missed.
    const realOpenSync = fs.openSync.bind(fs)
    const open = vi.spyOn(fs, 'openSync').mockImplementation(((
      target: fs.PathLike,
      flags: fs.OpenMode,
      mode?: fs.Mode,
    ): number => {
      if (typeof flags === 'number' && (flags & fs.constants.O_EXCL) !== 0) {
        fs.writeFileSync(target, 'gw_racedwinner\n', { mode: 0o600 })
        fs.chmodSync(target, 0o600)
        throw errno('EEXIST', 'EEXIST: file already exists, open for exclusive create')
      }
      return realOpenSync(target, flags, mode)
    }) as typeof fs.openSync)

    try {
      expect(fs.existsSync(file)).toBe(false)
      const returned = loadOrCreateGatewayToken(home)
      // Must reuse exactly the winner's persisted token, not the freshly
      // minted one, and must leave the winner's bytes untouched.
      expect(returned).toBe('gw_racedwinner')
      expect(fs.readFileSync(file, 'utf8')).toBe('gw_racedwinner\n')
      expect(open).toHaveBeenCalled()
    } finally {
      open.mockRestore()
    }
  })

  it('fails closed when the O_EXCL create itself throws ELOOP', () => {
    const home = tempHome()
    const file = gatewayTokenPath(home)
    // The path is absent for the initial read, then the create hits ELOOP
    // (e.g. a parent component was swapped for a symlink loop).
    const loop = errno('ELOOP', 'ELOOP: too many levels of symbolic links')
    const realOpenSync = fs.openSync.bind(fs)
    vi.spyOn(fs, 'openSync').mockImplementation(((
      target: fs.PathLike,
      flags: fs.OpenMode,
      mode?: fs.Mode,
    ): number => {
      if (typeof flags === 'number' && (flags & fs.constants.O_EXCL) !== 0) throw loop
      return realOpenSync(target, flags, mode)
    }) as typeof fs.openSync)

    expect(fs.existsSync(file)).toBe(false)
    let returned: string | undefined
    expect(() => { returned = loadOrCreateGatewayToken(home) }).toThrow(GatewayTokenFileError)
    expect(() => loadOrCreateGatewayToken(home)).toThrow(/changed while being opened \(ELOOP\)/)
    expect(returned).toBeUndefined()
    // No token file was created and no token was handed back.
    expect(fs.existsSync(file)).toBe(false)
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

import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bindRolePorts } from '../src/core/role-ports.ts'
import {
  BROWSER_PROTOCOL,
  BrowserErrands,
  IRREVERSIBLE_BROWSER_ACTIONS,
  MAX_BROWSER_OUTPUT_BYTES,
  assertAllowedUrl,
  createBrowserDriver,
  loadBrowserErrands,
  normalizeBrowserErrands,
  type BrowserDriver,
  type BrowserErrandConfig,
  type BrowserErrandRequest,
} from '../src/env/browser-errands.ts'
import { LocalEnv } from '../src/env/local-env.ts'
import type { Completion, Model } from '../src/harness/model.ts'
import { runTurn } from '../src/harness/loop.ts'
import { SessionJournal } from '../src/harness/session.ts'
import { ToolRegistry } from '../src/harness/tools.ts'
import { ruleClassify } from '../src/ingress/filter.ts'
import { isSecretEnvName } from '../src/env/sanitize.ts'
import { Runtime } from '../src/runtime.ts'
import type { Ticket, Trigger } from '../src/shared/types.ts'
import { shutdown, tempHome } from './fixtures.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, 'fixtures', 'browser-driver-fixture.mjs')
const cleanups: (() => Promise<void> | void)[] = []
const runtimes: Runtime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await shutdown(runtime)
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const scriptedModel: Model = {
  name: 'BrowserErrandScript',
  classify(trigger: Trigger) {
    return ruleClassify(trigger)
  },
  async complete(): Promise<Completion> {
    return { text: 'ok' }
  },
}

function configHome(): string {
  const home = tempHome()
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

function rawCommandConfig(mode = 'echo', driver: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    driver: {
      kind: 'command',
      command: process.execPath,
      args: [fixture, mode],
      timeoutMs: 5_000,
      ...driver,
    },
    allowedHosts: ['example.com', '*.example.org'],
    maxReadChars: 20,
    maxExtractItems: 2,
  }
}

function enabled(raw: Record<string, unknown> = rawCommandConfig()): BrowserErrandConfig {
  const config = normalizeBrowserErrands(raw)
  if (!config) throw new Error('test config must be enabled')
  return config
}

function commandErrands(mode = 'echo', driver: Record<string, unknown> = {}): BrowserErrands {
  const config = enabled(rawCommandConfig(mode, driver))
  return new BrowserErrands(createBrowserDriver(config), config)
}

class FakeDriver implements BrowserDriver {
  readonly kind = 'command' as const
  readonly requests: BrowserErrandRequest[] = []

  constructor(
    private readonly respond: (request: BrowserErrandRequest) =>
      Record<string, unknown> | Promise<Record<string, unknown>>,
  ) {}

  async run(request: BrowserErrandRequest): Promise<Record<string, unknown>> {
    this.requests.push(request)
    return this.respond(request)
  }
}

function fakeErrands(respond: (request: BrowserErrandRequest) => Record<string, unknown> = () => ({ text: 'page' })): {
  driver: FakeDriver
  errands: BrowserErrands
} {
  const driver = new FakeDriver(respond)
  return { driver, errands: new BrowserErrands(driver, enabled()) }
}

function putTicket(runtime: Runtime, id: string, overrides: Partial<Ticket> = {}): Ticket {
  const ticket: Ticket = {
    id,
    title: 'browse',
    brief: 'use the browser driver',
    mandate: {
      strength: 'explicit',
      policyVersion: 'test',
      scope: 'test',
      actor: { source: 'cli', id: 'tester' },
      basis: 'addressed',
    },
    threadKeys: [],
    channels: [],
    inputs: [],
    assignments: [],
    speculative: false,
    originTriggerId: 'trigger_test',
    createdAt: '2026-11-05T00:00:00.000Z',
    ...overrides,
  }
  runtime.store.putDoc('ticket', id, ticket)
  return ticket
}

function toolsFor(runtime: Runtime, errands: BrowserErrands): ToolRegistry {
  return new ToolRegistry({
    store: runtime.store,
    ports: bindRolePorts(runtime.engine),
    env: new LocalEnv(path.join(runtime.home, 'workspaces')),
    metrics: runtime.metrics,
    redact: text => text,
    log: () => {},
    scheduleJob: () => {},
    routerTurn: async () => {},
    browserErrands: errands,
  })
}

describe('browser errand configuration', () => {
  it('is disabled when the file and environment are both missing', () => {
    expect(loadBrowserErrands(configHome(), {})).toBeUndefined()
  })

  it('treats a blank file as disabled and suppresses the environment seed', () => {
    const home = configHome()
    fs.writeFileSync(path.join(home, 'browser-errands.json'), '  \n')
    expect(loadBrowserErrands(home, {
      DS_AGENT_BROWSER_ERRANDS: JSON.stringify(rawCommandConfig()),
    })).toBeUndefined()
  })

  it('loads the environment seed and lets the file win', () => {
    const seed = { DS_AGENT_BROWSER_ERRANDS: JSON.stringify(rawCommandConfig()) }
    expect(loadBrowserErrands(configHome(), seed)?.allowedHosts).toEqual(['example.com', '*.example.org'])

    const home = configHome()
    fs.writeFileSync(path.join(home, 'browser-errands.json'), JSON.stringify({ enabled: false }))
    expect(loadBrowserErrands(home, seed)).toBeUndefined()
  })

  it('fails loudly on malformed JSON and unknown keys', () => {
    const home = configHome()
    fs.writeFileSync(path.join(home, 'browser-errands.json'), '{ nope')
    expect(() => loadBrowserErrands(home, {})).toThrow(/not valid JSON/)

    const other = configHome()
    fs.writeFileSync(path.join(other, 'browser-errands.json'), JSON.stringify({ enabled: true, extra: 1 }))
    expect(() => loadBrowserErrands(other, {})).toThrow(/unknown key/)
  })

  it('requires a driver, allowed hosts, and a real timeout when enabled', () => {
    expect(() => normalizeBrowserErrands({ enabled: true, allowedHosts: ['example.com'] })).toThrow(/driver/)
    expect(() => normalizeBrowserErrands({
      enabled: true,
      driver: { kind: 'command', command: process.execPath },
      allowedHosts: [],
    })).toThrow(/allowedHosts/)
    expect(() => normalizeBrowserErrands({
      enabled: true,
      driver: { kind: 'command', command: process.execPath, timeoutMs: 1 },
      allowedHosts: ['example.com'],
    })).toThrow(/timeoutMs/)
  })

  it('rejects shell strings, option-shaped commands, and non-host allowlist entries', () => {
    expect(() => normalizeBrowserErrands(rawCommandConfig('echo', { command: 'claude; rm -rf /' })))
      .toThrow(/shell string/)
    expect(() => normalizeBrowserErrands(rawCommandConfig('echo', { command: '-rf' })))
      .toThrow(/command/)
    expect(() => normalizeBrowserErrands({
      enabled: true,
      driver: { kind: 'command', command: process.execPath },
      allowedHosts: ['https://example.com/path'],
    })).toThrow(/hostname/)
  })

  it('accepts https or loopback http for the remote driver and rejects the rest', () => {
    const httpConfig = (url: string, tokenEnv?: string) => normalizeBrowserErrands({
      enabled: true,
      driver: { kind: 'http', url, ...(tokenEnv ? { tokenEnv } : {}) },
      allowedHosts: ['example.com'],
    })
    expect(httpConfig('https://browser.example.net/errand')).toBeTruthy()
    expect(httpConfig('http://127.0.0.1:8080/errand')).toBeTruthy()
    expect(() => httpConfig('http://browser.example.net/errand')).toThrow(/loopback/)
    expect(() => httpConfig('https://user:pass@browser.example.net/errand')).toThrow(/credentials/)
  })

  it('enforces the HTTP endpoint policy for programmatic config too', () => {
    const config = {
      ...enabled(),
      driver: {
        kind: 'http' as const,
        url: 'http://browser.example.net/errand',
        tokenEnv: 'BROWSER_TOKEN',
        timeoutMs: 5_000,
      },
    }
    expect(() => createBrowserDriver(config, { env: { BROWSER_TOKEN: 'synthetic-token' } }))
      .toThrow(/loopback/)
  })

  it('fails closed when the configured command is not on PATH', () => {
    const config = enabled(rawCommandConfig('echo', { command: 'definitely-not-a-real-browser-driver' }))
    expect(() => createBrowserDriver(config)).toThrow(/not found on PATH/)
  })

  it('rejects executable directories during startup validation', () => {
    const config = enabled(rawCommandConfig('echo', { command: configHome() }))
    expect(() => createBrowserDriver(config)).toThrow(/not executable/)
  })

  it('fails closed when a configured token environment name is unset', () => {
    const config = enabled({
      enabled: true,
      driver: { kind: 'http', url: 'https://browser.example.net/errand', tokenEnv: 'BROWSER_TOKEN' },
      allowedHosts: ['example.com'],
    })
    expect(() => createBrowserDriver(config, { env: {} })).toThrow(/token env BROWSER_TOKEN is not set/)
    expect(createBrowserDriver(config, { env: { BROWSER_TOKEN: 'secret-token' } })).toBeTruthy()
  })
})

describe('browser URL allowlist', () => {
  it('matches exact hosts and wildcard subdomains only', () => {
    expect(assertAllowedUrl('https://example.com/a', ['example.com']).host).toBe('example.com')
    expect(assertAllowedUrl('https://sub.example.org/a', ['*.example.org']).host).toBe('sub.example.org')
    expect(() => assertAllowedUrl('https://example.org/a', ['*.example.org'])).toThrow(/allowlist/)
    expect(() => assertAllowedUrl('https://evil.test/a', ['example.com'])).toThrow(/allowlist/)
  })

  it('refuses non-http schemes and embedded credentials', () => {
    expect(() => assertAllowedUrl('file:///etc/passwd', ['example.com'])).toThrow(/http/)
    expect(() => assertAllowedUrl('javascript:alert(1)', ['example.com'])).toThrow(/http/)
    expect(() => assertAllowedUrl('https://user:pass@example.com/', ['example.com'])).toThrow(/credentials/)
    expect(() => assertAllowedUrl('not a url', ['example.com'])).toThrow(/absolute/)
  })

  it('rejects a driver-reported cross-origin location after every safe operation', async () => {
    const actions = ['navigate', 'read', 'fill', 'extract'] as const
    for (const action of actions) {
      const { errands } = fakeErrands(() => ({
        url: 'https://evil.test/redirected',
        text: 'page',
        filled: 1,
        items: [],
      }))
      const operation = action === 'navigate'
        ? errands.navigate('worker_1', 'https://example.com/start')
        : action === 'read'
          ? errands.read('worker_1')
          : action === 'fill'
            ? errands.fill('worker_1', [{ selector: '#q', value: 'hello' }])
            : errands.extract('worker_1')
      await expect(operation).rejects.toThrow(/allowlist/)
    }
  })

  it('blocks writes after a disallowed location and serializes session actions', async () => {
    let finish!: (result: Record<string, unknown>) => void
    const driver = new FakeDriver(() => new Promise<Record<string, unknown>>(resolve => { finish = resolve }))
    const errands = new BrowserErrands(driver, enabled())
    const navigation = errands.navigate('worker_1', 'https://example.com/start')

    expect(driver.requests).toHaveLength(1)
    await expect(errands.fill('worker_1', [{ selector: '#q', value: 'private value' }]))
      .rejects.toThrow(/in-flight action/)
    expect(driver.requests).toHaveLength(1)

    finish({ url: 'https://evil.test/redirected' })
    await expect(navigation).rejects.toThrow(/allowlist/)
    await expect(errands.fill('worker_1', [{ selector: '#q', value: 'private value' }]))
      .rejects.toThrow(/session is blocked/)
    expect(driver.requests).toHaveLength(1)
  })

  it('passes the owner allowlist so the driver can precheck fill origin', async () => {
    let currentUrl = 'https://example.com/start'
    let appliedValues = 0
    const { driver, errands } = fakeErrands(request => {
      if (request.action === 'navigate') return { url: currentUrl }
      if (request.action === 'fill') {
        const currentHost = new URL(currentUrl).hostname
        if (!request.allowedHosts?.includes(currentHost)) {
          throw new Error('active page URL is not allowlisted')
        }
        appliedValues += request.fields?.length ?? 0
        return { url: currentUrl, filled: request.fields?.length ?? 0 }
      }
      return { url: currentUrl, text: 'page', items: [] }
    })

    await errands.navigate('worker_1', 'https://example.com/start')
    currentUrl = 'https://evil.test/redirected'
    await expect(errands.fill('worker_1', [{ selector: '#q', value: 'private value' }]))
      .rejects.toThrow(/active page URL is not allowlisted/)

    expect(driver.requests[1]?.allowedHosts).toEqual(['example.com', '*.example.org'])
    expect(appliedValues).toBe(0)
  })

  it('bounds total extract text including the returned URL metadata', async () => {
    const config = enabled({ ...rawCommandConfig(), maxReadChars: 100 })
    const driver = new FakeDriver(() => ({
      url: 'https://example.com/page',
      items: ['x'.repeat(900_000), 'second item'],
    }))
    const errands = new BrowserErrands(driver, config)
    const result = await errands.extract('worker_extract')
    expect(result.url).toBe('https://example.com/page')
    const returnedTextLength = (result.items ?? []).join('').length
    expect(returnedTextLength + result.url!.length).toBeLessThanOrEqual(100)
    expect(result.items?.[0]).toHaveLength(100 - result.url!.length)
    expect(result.truncated).toBe(true)
  })

  it('blocks an Assignment after incomplete results and gives retries a fresh driver session', async () => {
    const driver = new FakeDriver(request => request.action === 'read'
      ? { url: 'https://example.com/page' }
      : { url: 'https://example.com/page', filled: 1 })
    const errands = new BrowserErrands(driver, enabled())
    await expect(errands.read('worker_retry')).rejects.toThrow(/needs a string text/)
    await expect(errands.fill('worker_retry', [{ selector: '#q', value: 'x' }]))
      .rejects.toThrow(/session is blocked/)
    expect(driver.requests).toHaveLength(1)

    errands.beginAssignment('worker_retry', 'assignment_retry_2')
    await expect(errands.fill('worker_retry', [{ selector: '#q', value: 'x' }]))
      .resolves.toMatchObject({ action: 'fill', filled: 1 })
    expect(driver.requests[1]?.session).toBe('worker_retry#assignment_retry_2')
  })

  it('requires a post-action URL for every safe operation', async () => {
    const actions = ['navigate', 'read', 'fill', 'extract'] as const
    for (const action of actions) {
      const { errands } = fakeErrands(() => ({ text: 'page', filled: 1, items: [] }))
      const operation = action === 'navigate'
        ? errands.navigate('worker_1', 'https://example.com/start')
        : action === 'read'
          ? errands.read('worker_1')
          : action === 'fill'
            ? errands.fill('worker_1', [{ selector: '#q', value: 'hello' }])
            : errands.extract('worker_1')
      await expect(operation).rejects.toThrow(/result needs a string url/)
    }
  })
})

describe('command browser driver', () => {
  it('sends the ds-agent protocol envelope and keeps the worker session stable', async () => {
    const errands = commandErrands()
    cleanups.push(() => errands.killAll())
    const config = enabled()
    const driver = createBrowserDriver(config)
    const result = await driver.run({
      protocol: BROWSER_PROTOCOL,
      action: 'navigate',
      session: 'worker_1',
      url: 'https://example.com/page',
    }) as { echo: { protocol: string; action: string; session: string; url: string } }
    expect(result.echo).toEqual({
      protocol: BROWSER_PROTOCOL,
      action: 'navigate',
      session: 'worker_1',
      url: 'https://example.com/page',
    })
  })

  it('navigates, reads, fills, and extracts within the configured bounds', async () => {
    const errands = commandErrands()
    cleanups.push(() => errands.killAll())
    await expect(errands.navigate('worker_1', 'https://example.com/page')).resolves.toMatchObject({
      action: 'navigate',
      url: 'https://example.com/page',
      title: 'Example Domain',
    })

    const read = await errands.read('worker_1')
    expect(read.text).toHaveLength(20)
    expect(read.truncated).toBe(true)

    const fill = await errands.fill('worker_1', [{ selector: '#q', value: 'hello' }])
    expect(fill.filled).toBe(1)

    const extract = await errands.extract('worker_1', 'a')
    expect(extract.items).toEqual(['one', 'two'])
    expect(extract.truncated).toBe(true)
  })

  it('requires owner allowlists on raw fill requests', async () => {
    const driver = createBrowserDriver(enabled())
    await expect(driver.run({
      protocol: BROWSER_PROTOCOL,
      action: 'fill',
      session: 'worker_1',
      fields: [{ selector: '#q', value: 'private value' }],
    })).rejects.toThrow(/allowedHosts/)
  })

  it('refuses irreversible actions even when a caller bypasses the typed API', async () => {
    const driver = createBrowserDriver(enabled(rawCommandConfig('irreversible')))
    for (const action of IRREVERSIBLE_BROWSER_ACTIONS) {
      const request = {
        protocol: BROWSER_PROTOCOL,
        action,
        session: 'worker_1',
      } as unknown as BrowserErrandRequest
      await expect(driver.run(request)).rejects.toThrow(
        new RegExp(`irreversible browser action ${action}`),
      )
    }
  })

  it('surfaces driver error envelopes and non-zero exits without leaking stderr', async () => {
    const failed = commandErrands('error')
    cleanups.push(() => failed.killAll())
    await expect(failed.navigate('worker_1', 'https://example.com/')).rejects.toThrow(
      /driver failed: driver exploded second line/,
    )

    const exited = commandErrands('exit')
    cleanups.push(() => exited.killAll())
    await expect(exited.read('worker_1')).rejects.toThrow(/exited with code 7: driver failed on purpose/)
  })

  it('rejects invalid driver output', async () => {
    const bad = commandErrands('badjson')
    cleanups.push(() => bad.killAll())
    await expect(bad.read('worker_1')).rejects.toThrow(/invalid JSON/)
  })

  it('preserves UTF-8 characters split across stdout chunks', async () => {
    const errands = commandErrands('split-utf8')
    cleanups.push(() => errands.killAll())
    await expect(errands.read('worker_split')).resolves.toMatchObject({ text: '€' })
  })

  it('enforces the stdout capture limit in UTF-8 bytes', async () => {
    const errands = commandErrands('oversized-utf8')
    cleanups.push(() => errands.killAll())
    await expect(errands.read('worker_oversized')).rejects.toThrow(/output exceeded the capture limit/)
  })

  it('redacts command envelope errors before clipping them', async () => {
    const token = 'command-diagnostic-token-sentinel'
    const config = enabled(rawCommandConfig('error-token', { env: ['DIAG_TOKEN'] }))
    const errands = new BrowserErrands(
      createBrowserDriver(config, { env: { DIAG_TOKEN: token } }),
      config,
    )
    let message = ''
    try {
      await errands.read('worker_diag')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('browser driver failed:')
    expect(message).not.toContain(token)
    expect(message).not.toContain(token.slice(0, 5))
  })

  it('settles timed-out commands when a detached helper keeps stdout open', async () => {
    const home = configHome()
    const pidPath = path.join(home, 'detached-helper.pid')
    const config = enabled(rawCommandConfig('inherited-pipe', {
      args: [fixture, 'inherited-pipe', pidPath],
      timeoutMs: 150,
    }))
    const driver = createBrowserDriver(config)
    let helperPid: number | undefined
    const started = Date.now()
    try {
      await expect(driver.run({
        protocol: BROWSER_PROTOCOL,
        action: 'navigate',
        session: 'worker_pipe',
        url: 'https://example.com/',
      })).rejects.toThrow(/timed out/)
      expect(Date.now() - started).toBeLessThan(1_000)
      helperPid = Number(fs.readFileSync(pidPath, 'utf8'))
      expect(Number.isInteger(helperPid)).toBe(true)
    } finally {
      driver.killAll?.()
      if (helperPid && Number.isInteger(helperPid)) {
        try { process.kill(helperPid, 'SIGKILL') } catch { /* helper already exited */ }
      }
    }
  })

  it('kills a timed-out driver and refuses later calls after shutdown', async () => {
    const timed = commandErrands('slow', { timeoutMs: 150 })
    await expect(timed.read('worker_1')).rejects.toThrow(/timed out/)
    timed.killAll()
    await expect(timed.read('worker_1')).rejects.toThrow(/shut down/)
  })

  it('rejects invalid fill fields at the adapter boundary', async () => {
    const { errands } = fakeErrands(() => ({ filled: 1 }))
    await expect(errands.fill('worker_1', [])).rejects.toThrow(/at least one/)
    await expect(errands.fill('worker_1', [
      { selector: '#q', value: 'x', submit: true } as unknown as { selector: string; value: string },
    ])).rejects.toThrow(/unknown key submit/)
  })
})

async function startServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server has no address')
  return {
    url: `http://127.0.0.1:${address.port}/errand`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    }),
  }
}

describe('remote (http) browser driver', () => {
  it('posts the protocol envelope with a bearer token and parses the result', async () => {
    let authorization: string | undefined
    let body: Record<string, unknown> | undefined
    const server = await startServer((request, response) => {
      authorization = request.headers.authorization
      let raw = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { raw += chunk })
      request.on('end', () => {
        body = JSON.parse(raw) as Record<string, unknown>
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          ok: true,
          result: { url: 'https://example.com/page', title: 'Remote' },
        }))
      })
    })
    cleanups.push(server.close)
    const config = enabled({
      enabled: true,
      driver: { kind: 'http', url: server.url, tokenEnv: 'BROWSER_TOKEN', timeoutMs: 5_000 },
      allowedHosts: ['example.com'],
    })
    const errands = new BrowserErrands(
      createBrowserDriver(config, { env: { BROWSER_TOKEN: 'secret-token' } }),
      config,
    )
    const result = await errands.navigate('worker_http', 'https://example.com/page')
    expect(result).toMatchObject({ action: 'navigate', url: 'https://example.com/page', title: 'Remote' })
    expect(authorization).toBe('Bearer secret-token')
    expect(body).toMatchObject({
      protocol: BROWSER_PROTOCOL,
      action: 'navigate',
      session: 'worker_http',
      url: 'https://example.com/page',
    })
  })

  it('streams HTTP responses, caps UTF-8 bytes, and cancels oversized bodies', async () => {
    const chunk = new TextEncoder().encode('€'.repeat(20_000))
    let emitted = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted === 32) {
          controller.close()
          return
        }
        emitted += 1
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }))
    try {
      const config = enabled({
        enabled: true,
        driver: { kind: 'http', url: 'http://127.0.0.1:8080/errand' },
        allowedHosts: ['example.com'],
      })
      const errands = new BrowserErrands(createBrowserDriver(config), config)
      await expect(errands.read('worker_http')).rejects.toThrow(/exceeded the capture limit/)
      expect(emitted * chunk.byteLength).toBeGreaterThan(MAX_BROWSER_OUTPUT_BYTES)
      expect(emitted).toBeLessThan(32)
      expect(cancelled).toBe(true)
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('cancels non-2xx response bodies before releasing the request', async () => {
    let didClose = false
    let resolveSocketClosed!: () => void
    const socketClosed = new Promise<void>(resolve => { resolveSocketClosed = resolve })
    const server = http.createServer((_request, response) => {
      response.writeHead(500, { 'content-type': 'text/plain' })
      response.write('synthetic open error body')
    })
    server.on('connection', socket => socket.once('close', () => {
      didClose = true
      resolveSocketClosed()
    }))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server has no address')
    const closeServer = () => new Promise<void>(resolve => {
      server.closeAllConnections()
      if (!server.listening) resolve()
      else server.close(() => resolve())
    })
    cleanups.push(closeServer)
    const config = enabled({
      enabled: true,
      driver: { kind: 'http', url: `http://127.0.0.1:${address.port}/errand`, timeoutMs: 5_000 },
      allowedHosts: ['example.com'],
    })
    const errands = new BrowserErrands(createBrowserDriver(config), config)
    await expect(errands.read('worker_http_open_error')).rejects.toThrow(/HTTP 500/)
    errands.killAll()
    await Promise.race([socketClosed, new Promise(resolve => setTimeout(resolve, 1_000))])
    expect(didClose).toBe(true)
  })

  it('redacts an HTTP envelope credential before clipping its diagnostic', async () => {
    const token = 'http-diagnostic-token-sentinel'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ ok: false, error: `${'x'.repeat(295)}${token}` }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    try {
      const config = enabled({
        enabled: true,
        driver: { kind: 'http', url: 'https://browser.invalid/errand', tokenEnv: 'HTTP_TOKEN' },
        allowedHosts: ['example.com'],
      })
      const errands = new BrowserErrands(
        createBrowserDriver(config, { env: { HTTP_TOKEN: token } }),
        config,
      )
      let message = ''
      try { await errands.read('worker_http_diag') } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toContain('browser driver failed:')
      expect(message).not.toContain(token)
      expect(message).not.toContain(token.slice(0, 5))
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('fails on a non-2xx response and does not follow redirects', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(302, { location: 'https://elsewhere.test/' })
      response.end()
    })
    cleanups.push(server.close)
    const config = enabled({
      enabled: true,
      driver: { kind: 'http', url: server.url, timeoutMs: 5_000 },
      allowedHosts: ['example.com'],
    })
    const errands = new BrowserErrands(createBrowserDriver(config), config)
    await expect(errands.read('worker_http')).rejects.toThrow(/HTTP 302/)
  })
})

describe('browser errand tools', () => {
  it('registers only the safe actions for workers', async () => {
    const runtime = Runtime.create({
      home: tempHome(),
      model: scriptedModel,
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      browserErrands: false,
    })
    runtimes.push(runtime)
    const { errands } = fakeErrands()
    const tools = toolsFor(runtime, errands)
    const worker = (await tools.specsFor('worker')).map(spec => spec.name)
    const router = (await tools.specsFor('router')).map(spec => spec.name)
    const watchdog = (await tools.specsFor('watchdog')).map(spec => spec.name)
    expect(worker.filter(name => name.startsWith('browser_'))).toEqual([
      'browser_navigate',
      'browser_read',
      'browser_fill',
      'browser_extract',
    ])
    expect(worker).not.toContain('browser_submit')
    expect(router.filter(name => name.startsWith('browser_'))).toEqual([])
    expect(watchdog.filter(name => name.startsWith('browser_'))).toEqual([])
  })

  it('runs inside a ticket and passes the worker session to the driver', async () => {
    const runtime = Runtime.create({
      home: tempHome(),
      model: scriptedModel,
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      browserErrands: false,
    })
    runtimes.push(runtime)
    putTicket(runtime, 'ticket_9')
    const { driver, errands } = fakeErrands(() => ({ url: 'https://example.com/page', title: 'Example' }))
    const tools = toolsFor(runtime, errands)
    const result = await tools.invoke(
      { id: 'b1', name: 'browser_navigate', args: { url: 'https://example.com/page' } },
      { sessionId: 'worker_ticket_9', role: 'worker', ticketId: 'ticket_9' },
    ) as { action: string; url: string }
    expect(result).toMatchObject({ action: 'navigate', url: 'https://example.com/page' })
    expect(driver.requests[0]).toMatchObject({
      protocol: BROWSER_PROTOCOL,
      action: 'navigate',
      session: 'worker_ticket_9',
    })
  })

  it('needs a live ticket and refuses ended tickets', async () => {
    const runtime = Runtime.create({
      home: tempHome(),
      model: scriptedModel,
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      browserErrands: false,
    })
    runtimes.push(runtime)
    const { errands } = fakeErrands()
    const tools = toolsFor(runtime, errands)
    const call = (ticketId?: string) => tools.invoke(
      { id: 'b2', name: 'browser_read', args: {} },
      { sessionId: 'worker_any', role: 'worker', ...(ticketId ? { ticketId } : {}) },
    )
    await expect(call()).rejects.toThrow(/active ticket/)
    await expect(call('ticket_missing')).rejects.toThrow(/active ticket/)

    putTicket(runtime, 'ticket_ended', {
      ended: { at: '2026-11-05T00:00:01.000Z', outcome: 'done', by: 'executor' },
    })
    await expect(call('ticket_ended')).rejects.toThrow(/has ended/)
  })

  it('lets a speculative worker read but not fill', async () => {
    const runtime = Runtime.create({
      home: tempHome(),
      model: scriptedModel,
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      browserErrands: false,
    })
    runtimes.push(runtime)
    putTicket(runtime, 'ticket_spec', { speculative: true })
    const { errands } = fakeErrands(() => ({ url: 'https://example.com/page', text: 'page', filled: 1 }))
    const tools = toolsFor(runtime, errands)
    await expect(tools.invoke(
      { id: 'b3', name: 'browser_read', args: {} },
      { sessionId: 'worker_ticket_spec', role: 'worker', ticketId: 'ticket_spec' },
    )).resolves.toMatchObject({ action: 'read', text: 'page' })
    await expect(tools.invoke(
      {
        id: 'b4',
        name: 'browser_fill',
        args: { fields: JSON.stringify([{ selector: '#q', value: 'x' }]) },
      },
      { sessionId: 'worker_ticket_spec', role: 'worker', ticketId: 'ticket_spec' },
    )).rejects.toThrow(/speculative/)
  })

  it('rejects malformed fields and keeps browser tools off the router', async () => {
    const runtime = Runtime.create({
      home: tempHome(),
      model: scriptedModel,
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      browserErrands: false,
    })
    runtimes.push(runtime)
    putTicket(runtime, 'ticket_1')
    const { errands } = fakeErrands(() => ({ filled: 1 }))
    const tools = toolsFor(runtime, errands)
    await expect(tools.invoke(
      { id: 'b5', name: 'browser_fill', args: { fields: 'nope' } },
      { sessionId: 'worker_ticket_1', role: 'worker', ticketId: 'ticket_1' },
    )).rejects.toThrow(/valid JSON/)
    await expect(tools.invoke(
      { id: 'b6', name: 'browser_read', args: {} },
      { sessionId: 'router', role: 'router', ticketId: 'ticket_1' },
    )).rejects.toThrow(/not available to router/)
  })

  it('redacts an echoed HTTP token from the Worker model and journal', async () => {
    const sentinel = 'browser-sentinel-7f3a'
    const tokenEnv = 'BROWSER_HANDLE'
    const overlappingSecret = `prefix-${sentinel}-suffix`
    expect(isSecretEnvName(tokenEnv)).toBe(false)
    let authorization: unknown
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization')
      return new Response(JSON.stringify({ ok: false, error: `driver rejected ${sentinel}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    try {
      const runtime = Runtime.create({
        home: tempHome(),
        model: scriptedModel,
        env: { [tokenEnv]: sentinel, SERVICE_API_KEY: overlappingSecret },
        jobDelayMs: 0,
        watchdogIntervalMs: 60_000,
        browserErrands: enabled({
          enabled: true,
          driver: { kind: 'http', url: 'https://browser.invalid/errand', tokenEnv },
          allowedHosts: ['example.com'],
        }),
      })
      runtimes.push(runtime)
      putTicket(runtime, 'ticket_redact')
      const observedToolMessages: string[] = []
      let modelCalls = 0
      const model: Model = {
        ...scriptedModel,
        async complete(request): Promise<Completion> {
          modelCalls += 1
          if (modelCalls === 1) {
            return { toolCalls: [{ id: 'read_echo', name: 'browser_read', args: {} }] }
          }
          observedToolMessages.push(...request.messages
            .filter(message => message.role === 'tool')
            .map(message => message.content))
          return { text: 'done' }
        },
      }
      const tools = toolsFor(runtime, runtime.browserErrands!)
      const redact = (runtime as unknown as { redact: (text: string) => string }).redact
      expect(redact(`embedded=${overlappingSecret}`)).toBe('embedded=[redacted]')
      const journal = new SessionJournal(path.join(runtime.home, 'sessions'), runtime.store, () => {})
      const session = { id: 'worker_ticket_redact', role: 'worker' as const, ticketId: 'ticket_redact' }
      await runTurn({
        model,
        tools,
        journal,
        log: () => {},
        metrics: runtime.metrics,
        redact,
        session,
        prompt: 'Read the page.',
      })

      const toolMessage = journal.history(session.id).find(entry => entry.role === 'tool')?.content ?? ''
      expect(authorization).toBe(`Bearer ${sentinel}`)
      expect(observedToolMessages).toHaveLength(1)
      expect(observedToolMessages[0]).toContain('[redacted]')
      expect(toolMessage).toContain('[redacted]')
      expect(observedToolMessages.join('\n')).not.toContain(sentinel)
      expect(toolMessage).not.toContain(sentinel)
      expect(fs.readFileSync(path.join(runtime.home, 'sessions', `${session.id}.jsonl`), 'utf8')).not.toContain(sentinel)
    } finally {
      fetchMock.mockRestore()
    }
  })
})

describe('runtime wiring', () => {
  it('loads an enabled config at startup and shuts the driver down', async () => {
    const runtime = Runtime.create({
      home: tempHome(),
      model: scriptedModel,
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      browserErrands: enabled(),
    })
    runtimes.push(runtime)
    expect(runtime.browserErrands?.driverKind).toBe('command')
    expect(runtime.browserErrands?.allowedHosts).toEqual(['example.com', '*.example.org'])
  })

  it('fails startup for malformed config and missing executables', () => {
    const malformed = configHome()
    fs.writeFileSync(path.join(malformed, 'browser-errands.json'), '{"enabled":true,')
    expect(() => Runtime.create({
      home: malformed,
      model: scriptedModel,
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
    })).toThrow(/not valid JSON/)

    const invalidDriverHome = configHome()
    expect(() => Runtime.create({
      home: invalidDriverHome,
      model: scriptedModel,
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      browserErrands: enabled(rawCommandConfig('echo', { command: 'definitely-not-a-real-browser-driver' })),
    })).toThrow(/not found on PATH/)
    expect(fs.existsSync(path.join(invalidDriverHome, 'ds-agent.db'))).toBe(false)
  })

  it('honors an explicit disable even when a config file exists', () => {
    const home = configHome()
    fs.writeFileSync(path.join(home, 'browser-errands.json'), JSON.stringify(rawCommandConfig()))
    const runtime = Runtime.create({
      home,
      model: scriptedModel,
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      browserErrands: false,
    })
    runtimes.push(runtime)
    expect(runtime.browserErrands).toBeUndefined()
  })
})

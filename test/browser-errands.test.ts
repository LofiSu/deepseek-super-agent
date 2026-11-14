import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bindRolePorts } from '../src/core/role-ports.ts'
import {
  BROWSER_PROTOCOL,
  BrowserErrands,
  IRREVERSIBLE_BROWSER_ACTIONS,
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
import { ToolRegistry } from '../src/harness/tools.ts'
import { ruleClassify } from '../src/ingress/filter.ts'
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

  constructor(private readonly respond: (request: BrowserErrandRequest) => Record<string, unknown>) {}

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

  it('fails closed when the configured command is not on PATH', () => {
    const config = enabled(rawCommandConfig('echo', { command: 'definitely-not-a-real-browser-driver' }))
    expect(() => createBrowserDriver(config)).toThrow(/not found on PATH/)
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
    const { errands } = fakeErrands(() => ({ text: 'page', filled: 1 }))
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

    expect(() => Runtime.create({
      home: tempHome(),
      model: scriptedModel,
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      browserErrands: enabled(rawCommandConfig('echo', { command: 'definitely-not-a-real-browser-driver' })),
    })).toThrow(/not found on PATH/)
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

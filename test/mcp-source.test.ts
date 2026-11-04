import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { McpToolSource, childEnv, mcpToolName } from '../src/harness/mcp.ts'
import { parseMcpServers } from '../src/harness/mcp-config.ts'

const serverPath = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url))
const hungPath = fileURLToPath(new URL('./fixtures/hung-mcp-server.mjs', import.meta.url))

function sourceFor(configs: unknown, listTimeoutMs?: number) {
  return new McpToolSource(parseMcpServers(configs), {
    log: () => {},
    metrics: { increment: () => {} },
    redact: text => text,
    spill: { put: () => 'spill_1' },
    workspaceDir: path.join(fileURLToPath(new URL('.', import.meta.url)), 'tmp-mcp'),
    ...(listTimeoutMs === undefined ? {} : { listTimeoutMs }),
  })
}

describe('McpToolSource', () => {
  it('lists namespaced tools from a connected server', async () => {
    const source = sourceFor([{ name: 'fake', command: process.execPath, args: [serverPath] }])
    const specs = await source.specs()
    expect(specs.map(spec => spec.name)).toEqual(expect.arrayContaining([
      mcpToolName('fake', 'echo'),
      mcpToolName('fake', 'big'),
      mcpToolName('fake', 'fail'),
      mcpToolName('fake', 'hang'),
    ]))
    await source.close()
  })

  it('keeps a good server when another fails to start', async () => {
    const source = sourceFor([
      { name: 'broken', command: '/definitely/not/a/binary' },
      { name: 'fake', command: process.execPath, args: [serverPath] },
    ])
    const specs = await source.specs()
    expect(specs.some(spec => spec.name.startsWith('mcp__fake__'))).toBe(true)
    expect(specs.some(spec => spec.name.startsWith('mcp__broken__'))).toBe(false)
    await source.close()
  })

  it('omits a server that never finishes initialize without stalling the listing', async () => {
    const source = sourceFor([
      { name: 'hung', command: process.execPath, args: [hungPath] },
      { name: 'fake', command: process.execPath, args: [serverPath] },
    ], 3_000)
    const started = Date.now()
    const specs = await source.specs()
    expect(Date.now() - started).toBeLessThan(9_000)
    expect(specs.some(spec => spec.name.startsWith('mcp__fake__'))).toBe(true)
    expect(specs.some(spec => spec.name.startsWith('mcp__hung__'))).toBe(false)
    await source.close()
  })

  it('rejects a tool name that matches no configured server', async () => {
    const source = sourceFor([{ name: 'fake', command: process.execPath, args: [serverPath] }])
    await expect(source.invoke('other__fake__echo', {})).rejects.toThrow(/not configured/)
    await source.close()
  })

  it('routes by the longest server prefix when names share an underscore', async () => {
    const source = sourceFor([
      { name: 'fake', command: process.execPath, args: [serverPath] },
      { name: 'fake_extra', command: process.execPath, args: [serverPath] },
    ])
    const result = await source.invoke('mcp__fake_extra__echo', { text: 'hi' })
    expect(result).toBe('{"text":"hi"}')
    await source.close()
  })

  it('builds an allowlisted child environment', () => {
    const env = childEnv({ name: 'x', command: 'x', args: [], env: { EXTRA: '1' }, timeoutMs: 1000 }, {
      PATH: '/bin',
      HOME: '/home/u',
      LANG: 'en',
      TZ: 'UTC',
      SECRET: 'nope',
    } as NodeJS.ProcessEnv)
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/u', LANG: 'en', TZ: 'UTC', EXTRA: '1' })
  })
})

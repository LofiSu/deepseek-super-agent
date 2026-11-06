import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { McpToolSource, type McpToolSourceDeps } from '../src/harness/mcp.ts'
import { parseMcpServers } from '../src/harness/mcp-config.ts'

const serverPath = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url))
const workspaceDir = fileURLToPath(new URL('./tmp-mcp-invoke', import.meta.url))

async function source(timeoutMs = 5_000, overrides: Partial<McpToolSourceDeps> = {}) {
  return new McpToolSource(parseMcpServers([{ name: 'fake', command: process.execPath, args: [serverPath], timeoutMs }]), {
    log: () => {},
    metrics: { increment: () => {} },
    redact: text => text,
    spill: { put: () => 'spill_1' },
    workspaceDir,
    ...overrides,
  })
}

describe('McpToolSource.invoke', () => {
  it('passes array arguments through', async () => {
    const mcp = await source()
    await expect(mcp.invoke('mcp__fake__echo', { text: 'hi', tags: ['a', 'b'] }))
      .resolves.toContain('"tags":["a","b"]')
    await mcp.close()
  })

  it('spills oversized text results', async () => {
    const mcp = await source()
    await expect(mcp.invoke('mcp__fake__big', {})).resolves.toEqual({
      spillId: 'spill_1',
      bytes: expect.any(Number),
      preview: expect.any(String),
    })
    await mcp.close()
  })

  it('writes image blocks to disk instead of returning base64', async () => {
    const mcp = await source()
    const result = await mcp.invoke('mcp__fake__image', {}) as { paths: string[] }
    expect(result.paths).toHaveLength(1)
    expect(fs.existsSync(result.paths[0])).toBe(true)
    expect(JSON.stringify(result)).not.toContain('iVBORw0KGgo')
    await mcp.close()
  })

  it('redacts tool output before storing it in spill', async () => {
    const bodies: string[] = []
    const mcp = await source(5_000, {
      redact: text => text.replaceAll('TOKEN-123', '[redacted]'),
      spill: {
        put: body => {
          bodies.push(body)
          return 'spill_1'
        },
      },
    })
    await mcp.invoke('mcp__fake__big', {})
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).not.toContain('TOKEN-123')
    expect(bodies[0]).toContain('[redacted]')
    await mcp.close()
  })

  it('surfaces a tool error without closing the source', async () => {
    const mcp = await source()
    await expect(mcp.invoke('mcp__fake__fail', {})).rejects.toThrow(/boom/)
    await expect(mcp.invoke('mcp__fake__echo', { text: 'still alive' })).resolves.toContain('still alive')
    await mcp.close()
  })

  it('times out a slow call', async () => {
    const mcp = await source(50)
    await expect(mcp.invoke('mcp__fake__hang', {})).rejects.toThrow(/timed out after 50ms/)
    await mcp.close()
  })
})

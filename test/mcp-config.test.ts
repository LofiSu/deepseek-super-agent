import { describe, expect, it } from 'vitest'
import { parseMcpServers } from '../src/harness/mcp-config.ts'

describe('parseMcpServers', () => {
  it('accepts a minimal server and fills defaults', () => {
    expect(parseMcpServers([{ name: 'krene', command: 'krene-mcp', args: ['serve'] }])).toEqual([
      { name: 'krene', command: 'krene-mcp', args: ['serve'], env: {}, timeoutMs: 120000 },
    ])
  })

  it('returns an empty list for absent configuration', () => {
    expect(parseMcpServers(undefined)).toEqual([])
    expect(parseMcpServers(null)).toEqual([])
  })

  it('rejects duplicate names', () => {
    expect(() => parseMcpServers([
      { name: 'krene', command: 'a' },
      { name: 'krene', command: 'b' },
    ])).toThrow(/duplicate/i)
  })

  it.each([
    [{ name: 'bad name', command: 'a' }, /name/i],
    [{ name: 'a__b', command: 'a' }, /name/i],
    [{ name: 'krene', command: '   ' }, /command/i],
    [{ name: 'krene', command: 'a', args: [1] }, /args/i],
    [{ name: 'krene', command: 'a', env: { A: 1 } }, /env/i],
    [{ name: 'krene', command: 'a', timeoutMs: 0 }, /timeout/i],
  ])('rejects invalid entry %j', (entry, pattern) => {
    expect(() => parseMcpServers([entry])).toThrow(pattern)
  })
})

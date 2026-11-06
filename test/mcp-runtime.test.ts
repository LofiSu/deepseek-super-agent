import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import type { Runtime } from '../src/runtime.ts'
import type { Trigger } from '../src/shared/types.ts'
import { freshRuntime, shutdown } from './fixtures.ts'

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

describe('Runtime MCP configuration', () => {
  it('redacts credentials supplied through an MCP server env', () => {
    const token = 'krene-token-9f3a2b7c'
    runtime = freshRuntime({
      mcpServers: [{ name: 'krene', command: '/definitely/not/krene-mcp', env: { KRENE_TOKEN: token } }],
    })
    runtime.ingest(imTrigger({ id: 'trg_secret', thread: 'topic/secret', text: `leaked ${token} here` }))
    const [trigger] = runtime.store.listDocs<Trigger>('trigger')
    expect(trigger.text).not.toContain(token)
    expect(trigger.text).toContain('[redacted]')
  })

  it('starts when the MCP configuration is unreadable', () => {
    runtime = freshRuntime({ mcpServers: 'not json' })
    expect(runtime.store.isOpen).toBe(true)
  })
})

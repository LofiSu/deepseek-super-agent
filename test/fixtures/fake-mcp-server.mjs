#!/usr/bin/env node
// Minimal stdio MCP server used by the harness tests. It deliberately avoids
// zod by using the low-level Server + request schemas, so the fixture needs no
// dependency beyond the SDK itself.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

// 1x1 transparent PNG.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const tools = [
  {
    name: 'echo',
    description: 'Echo the arguments back as JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['text'],
    },
  },
  { name: 'big', description: 'Return 70 KB of text.', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'Always throws.', inputSchema: { type: 'object', properties: {} } },
  { name: 'hang', description: 'Wait 500 ms, then answer.', inputSchema: { type: 'object', properties: {} } },
  { name: 'image', description: 'Return a 1x1 PNG.', inputSchema: { type: 'object', properties: {} } },
]

const server = new Server(
  { name: 'fake-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args = {} } = request.params
  if (name === 'echo') return { content: [{ type: 'text', text: JSON.stringify(args) }] }
  if (name === 'big') return { content: [{ type: 'text', text: 'x'.repeat(70 * 1024) }] }
  if (name === 'fail') throw new Error('boom')
  if (name === 'hang') {
    await new Promise(resolve => setTimeout(resolve, 500))
    return { content: [{ type: 'text', text: 'slow but alive' }] }
  }
  if (name === 'image') return { content: [{ type: 'image', data: PNG_1X1, mimeType: 'image/png' }] }
  return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true }
})

await server.connect(new StdioServerTransport())
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))

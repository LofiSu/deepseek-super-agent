import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { MetricName } from '../metrics/metrics.ts'
import { UserError } from '../shared/errors.ts'
import type { McpServerConfig } from './mcp-config.ts'
import type { ToolSpec } from './model.ts'

export interface McpToolSourceDeps {
  log: (line: string) => void
  metrics: { increment(name: MetricName, by?: number): void }
  redact: (text: string) => string
  spill: { put(body: string): string }
  workspaceDir: string
  baseEnv?: NodeJS.ProcessEnv
}

export interface McpToolSourceLike {
  specs(): Promise<ToolSpec[]>
  invoke(name: string, args: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
}

const NAME_PREFIX = 'mcp__'
const LIST_TIMEOUT_MS = 10_000
const TIMED_OUT = Symbol('timed-out')

const INHERITED_ENV = [
  'PATH',
  'HOME',
  'LANG',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
] as const

export function mcpToolName(server: string, tool: string): string {
  return `${NAME_PREFIX}${server}__${tool}`
}

/**
 * Child processes see only what the harness chooses to pass: a fixed
 * inheritance allowlist plus the server's explicit config. Credentials in the
 * parent environment never reach a third-party MCP server by default.
 */
export function childEnv(
  config: McpServerConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of INHERITED_ENV) {
    const value = baseEnv[key]
    if (value !== undefined) env[key] = value
  }
  return { ...env, ...config.env }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

interface Connection {
  config: McpServerConfig
  client: Client
  /** Resolves true when the server finished its initialize handshake. */
  ready: Promise<boolean>
}

/**
 * M1 tool source: starts one stdio MCP server per config, lists their tools,
 * and namespaces them as `mcp__<server>__<tool>`.
 *
 * Connections start in the constructor so a slow server never delays Runtime
 * creation. `specs()` bounds the wait; a server that fails or never finishes
 * initializing is omitted without affecting the others.
 */
export class McpToolSource implements McpToolSourceLike {
  private readonly connections: Connection[] = []
  private listed?: Promise<ToolSpec[]>

  constructor(configs: McpServerConfig[], private readonly deps: McpToolSourceDeps) {
    for (const config of configs) {
      const client = new Client({ name: `ds-agent-${config.name}`, version: '0.1.0' })
      this.connections.push({ config, client, ready: this.connect(config, client) })
    }
  }

  specs(): Promise<ToolSpec[]> {
    this.listed ??= this.loadSpecs()
    return this.listed
  }

  async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    const connection = this.resolve(name)
    if (!connection) throw new UserError(`mcp tool ${name} is not configured`)
    const connected = await connection.ready
    if (!connected) throw new UserError(`mcp server ${connection.config.name} is not connected`)
    const tool = name.slice(mcpToolName(connection.config.name, '').length)
    if (!tool) throw new UserError(`mcp tool ${name} is not configured`)
    return connection.client.callTool({ name: tool, arguments: args })
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.connections.map(connection => connection.client.close()))
  }

  private async connect(config: McpServerConfig, client: Client): Promise<boolean> {
    try {
      await client.connect(new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: childEnv(config, this.deps.baseEnv),
        stderr: 'ignore',
      }))
      this.deps.metrics.increment('mcp.connect')
      this.deps.log(`[mcp] connected server=${config.name}`)
      return true
    } catch (error) {
      this.deps.metrics.increment('mcp.connect_error')
      this.deps.log(`[mcp] connect failed server=${config.name} error=${this.deps.redact(errorMessage(error))}`)
      return false
    }
  }

  private async loadSpecs(): Promise<ToolSpec[]> {
    const connected = await Promise.all(
      this.connections.map(connection => withTimeout(connection.ready, LIST_TIMEOUT_MS)),
    )
    const specs: ToolSpec[] = []
    await Promise.all(this.connections.map(async (connection, index) => {
      if (connected[index] !== true) {
        this.deps.log(`[mcp] skipping server=${connection.config.name} reason=not-connected`)
        return
      }
      try {
        const listed = await withTimeout(connection.client.listTools(), LIST_TIMEOUT_MS)
        if (listed === TIMED_OUT) {
          this.deps.log(`[mcp] skipping server=${connection.config.name} reason=list-timeout`)
          return
        }
        for (const tool of listed.tools) {
          specs.push({
            name: mcpToolName(connection.config.name, tool.name),
            description: tool.description ?? '',
            parameters: (tool.inputSchema ?? { type: 'object' }) as ToolSpec['parameters'],
          })
        }
      } catch (error) {
        this.deps.log(`[mcp] list failed server=${connection.config.name} error=${this.deps.redact(errorMessage(error))}`)
      }
    }))
    return specs
  }

  /** Longest configured `mcp__<server>__` prefix wins; server names may contain `_`. */
  private resolve(name: string): Connection | undefined {
    let match: Connection | undefined
    let matched = -1
    for (const connection of this.connections) {
      const prefix = mcpToolName(connection.config.name, '')
      if (name.startsWith(prefix) && prefix.length > matched) {
        match = connection
        matched = prefix.length
      }
    }
    return match
  }
}

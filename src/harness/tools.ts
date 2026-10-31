import type { SessionRole } from '../shared/types.js'
import { AgentError } from '../shared/errors.js'
import type { ModelToolSchema } from './model.js'

export interface JsonSchema {
  type: 'object'
  properties?: Record<string, { type: string; description?: string }>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolContext {
  sessionId: string
  role: SessionRole
  callId: string
}

export interface RegisteredTool {
  name: string
  description: string
  roles: readonly SessionRole[]
  parameters: JsonSchema
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>
}

/** Tools registered per session role. The harness does not decide which role a domain caller should use. */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) throw new AgentError('tool_exists', `tool ${tool.name} already registered`)
    this.tools.set(tool.name, tool)
  }

  list(role: SessionRole): RegisteredTool[] {
    return [...this.tools.values()].filter(tool => tool.roles.includes(role))
  }

  schemas(role: SessionRole): ModelToolSchema[] {
    return this.list(role).map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as unknown as Record<string, unknown>,
    }))
  }

  async invoke(role: SessionRole, name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const tool = this.tools.get(name)
    if (!tool || !tool.roles.includes(role)) throw new AgentError('tool_unknown', `tool ${name} is not registered for ${role}`)
    for (const key of tool.parameters.required ?? []) {
      if (args[key] === undefined) throw new AgentError('tool_args', `tool ${name} missing ${key}`)
    }
    return tool.run(args, ctx)
  }
}

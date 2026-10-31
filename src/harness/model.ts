import { AgentError } from '../shared/errors.js'

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolCalls?: ToolCall[]
}

export interface ModelToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ModelRequest {
  messages: ModelMessage[]
  tools: ModelToolSchema[]
}

export interface ModelResponse {
  content: string
  toolCalls: ToolCall[]
}

export interface Model {
  complete(request: ModelRequest): Promise<ModelResponse>
}

/** Deterministic model. Replays a script, then repeats the last reply. Echoes when the script is empty. */
export class MockModel implements Model {
  readonly calls: ModelRequest[] = []

  constructor(private readonly replies: ModelResponse[] = []) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request)
    if (this.replies.length === 0) {
      const last = [...request.messages].reverse().find(message => message.role === 'user')
      return { content: `mock:${last?.content ?? ''}`, toolCalls: [] }
    }
    const index = Math.min(this.calls.length - 1, this.replies.length - 1)
    const reply = this.replies[index]!
    return {
      content: reply.content,
      toolCalls: reply.toolCalls.map(call => ({ ...call, arguments: { ...call.arguments } })),
    }
  }
}

export interface HttpOpenAIOptions {
  base?: string
  apiKey?: string
  model?: string
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
}

interface OpenAIToolCall {
  id?: string
  function?: { name?: string; arguments?: string }
}

interface OpenAIResponse {
  choices?: { message?: { content?: string | null; tool_calls?: OpenAIToolCall[] } }[]
}

/** OpenAI-compatible chat completions. Reads DS_AGENT_API_BASE, DS_AGENT_API_KEY, and optional DS_AGENT_API_MODEL. */
export class HttpOpenAIModel implements Model {
  readonly base: string
  readonly apiKey: string
  readonly model: string
  private readonly fetchImpl: typeof fetch

  constructor(options: HttpOpenAIOptions = {}) {
    const env = options.env ?? process.env
    this.base = (options.base ?? env.DS_AGENT_API_BASE ?? '').replace(/\/$/, '')
    this.apiKey = options.apiKey ?? env.DS_AGENT_API_KEY ?? ''
    this.model = options.model ?? env.DS_AGENT_API_MODEL ?? 'ds-agent'
    this.fetchImpl = options.fetch ?? fetch
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (!this.base || !this.apiKey) throw new AgentError('model_config', 'DS_AGENT_API_BASE and DS_AGENT_API_KEY are required')
    const response = await this.fetchImpl(`${this.base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: request.messages.map(toOpenAIMessage),
        ...(request.tools.length
          ? {
            tools: request.tools.map(tool => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }
          : {}),
      }),
    })
    if (!response.ok) throw new AgentError('model_http', `model HTTP ${response.status}`)
    const json = await response.json() as OpenAIResponse
    const message = json.choices?.[0]?.message
    return {
      content: message?.content ?? '',
      toolCalls: (message?.tool_calls ?? []).map((call, index) => ({
        id: call.id || `call-${index + 1}`,
        name: call.function?.name ?? '',
        arguments: parseArgs(call.function?.arguments),
      })),
    }
  }
}

export function createModel(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): Model {
  if (env.DS_AGENT_API_BASE && env.DS_AGENT_API_KEY) return new HttpOpenAIModel({ env, fetch: fetchImpl })
  return new MockModel()
}

function toOpenAIMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', content: message.content, tool_call_id: message.toolCallId }
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map(call => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    }
  }
  return { role: message.role, content: message.content }
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return {}
  } catch {
    return {}
  }
}

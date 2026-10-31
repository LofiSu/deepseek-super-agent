import { ruleClassify, type SemanticHit, type SemanticModel } from '../ingress/filter.ts'
import type { Role } from '../shared/types.ts'
import type { Trigger } from '../shared/types.ts'

export interface ToolSpec {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description?: string }>
    additionalProperties: boolean
  }
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  toolCallId?: string
  toolCalls?: ToolCall[]
}

export interface CompletionRequest {
  role: Role
  messages: ModelMessage[]
  tools: ToolSpec[]
}

export interface Completion {
  text?: string
  toolCalls?: ToolCall[]
}

export interface Model extends SemanticModel {
  complete(request: CompletionRequest): Promise<Completion>
}

export function systemPrompt(role: Role): string {
  if (role === 'router') {
    return 'You are the RouterSession. Speak to the user with reply_user. Do not run bash. Stay quiet on speculative work until a report delivers.'
  }
  if (role === 'worker') {
    return 'You are a WorkerSession. Investigate with tools and report_to_router. Never message the user directly.'
  }
  return 'You are the WatchdogSession. Check stuck workers. Do not reply to users.'
}

function blobOf(messages: ModelMessage[]): string {
  return messages.map(message => message.content).join('\n')
}

function used(messages: ModelMessage[], name: string): boolean {
  return messages.some(message => message.role === 'tool' && message.name === name)
}

function count(messages: ModelMessage[], name: string): number {
  return messages.filter(message => message.role === 'tool' && message.name === name).length
}

function field(blob: string, key: string): string {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(blob)
  return match?.[1]?.trim() ?? ''
}

function call(name: string, args: Record<string, unknown>, n = 0): Completion {
  return { toolCalls: [{ id: `call_${name}_${n}`, name, args }] }
}

/** Deterministic stand-in. The demo never calls a network. */
export class MockModel implements Model {
  readonly name = 'MockModel'

  classify(trigger: Trigger): SemanticHit {
    return ruleClassify(trigger)
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    const blob = blobOf(request.messages)
    if (request.role === 'router') return this.router(request.messages, blob)
    if (request.role === 'watchdog') {
      if (!used(request.messages, 'list_tasks')) return call('list_tasks', {})
      return { text: '[watchdog] healthy' }
    }
    return this.worker(request.messages, blob)
  }

  private router(messages: ModelMessage[], blob: string): Completion {
    if (blob.includes('deliver=false')) return { text: '[router] speculative silent' }
    if (blob.includes('deliver=true')) {
      if (!used(messages, 'reply_user')) {
        return call('reply_user', {
          ticketId: field(blob, 'ticketId'),
          text: field(blob, 'reportText') || 'Done.',
          purpose: 'result',
        })
      }
      return { text: 'router done' }
    }
    if (blob.includes('mode=speculative') && !blob.includes('REPORT')) {
      return { text: '[router] speculative silent' }
    }
    if (blob.includes('TICKET_CREATED') && !used(messages, 'reply_user')) {
      const title = field(blob, 'title')
      return call('reply_user', {
        ticketId: field(blob, 'ticketId'),
        text: `Working on ${title}.`,
        purpose: 'result',
      })
    }
    if (!used(messages, 'list_tasks')) return call('list_tasks', {})
    return { text: 'router idle' }
  }

  private worker(messages: ModelMessage[], blob: string): Completion {
    if (blob.includes('JOB_DONE')) return { text: `job consumed ${field(blob, 'jobId')}` }
    const spill = field(blob, 'spillId') || (/spillId=(\S+)/.exec(blob)?.[1] ?? '')
    if (spill && !used(messages, 'read_object')) return call('read_object', { id: spill })
    if (!used(messages, 'bash')) return call('bash', { command: 'echo worker-ok' })
    if (!used(messages, 'write_file')) return call('write_file', { path: 'notes.txt', body: 'worker-ok\n' })
    if (!used(messages, 'start_job')) return call('start_job', { name: 'investigate' })
    const reports = count(messages, 'report_to_router')
    const speculative = blob.includes('mode=speculative')
    const ticketId = field(blob, 'ticketId')
    if (speculative && reports === 0) {
      return call('report_to_router', {
        ticketId,
        text: 'investigating quietly',
        deliver: false,
        kind: 'progress',
      }, reports)
    }
    if (reports === 0 || (speculative && reports === 1)) {
      return call('report_to_router', {
        ticketId,
        text: 'ready: investigation recorded',
        deliver: true,
        kind: 'ready',
      }, reports)
    }
    return { text: 'worker done' }
  }
}

/** OpenAI-compatible chat completions. Used when DS_AGENT_API_BASE and DS_AGENT_API_KEY are set. */
export class HttpOpenAI implements Model {
  readonly name = 'HttpOpenAI'

  constructor(
    private readonly base: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  classify(trigger: Trigger): SemanticHit {
    return ruleClassify(trigger)
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    const url = `${this.base.replace(/\/$/, '')}/chat/completions`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: request.messages.map(message => {
          if (message.role === 'tool') {
            return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
          }
          if (message.role === 'assistant' && message.toolCalls?.length) {
            return {
              role: 'assistant',
              content: message.content || null,
              tool_calls: message.toolCalls.map(toolCall => ({
                id: toolCall.id,
                type: 'function',
                function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) },
              })),
            }
          }
          return { role: message.role, content: message.content }
        }),
        tools: request.tools.map(tool => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
      }),
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`HttpOpenAI ${response.status} ${body.slice(0, 200)}`)
    }
    const json = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string | null
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
        }
      }>
    }
    const message = json.choices?.[0]?.message
    const toolCalls = (message?.tool_calls ?? []).map(toolCall => ({
      id: toolCall.id,
      name: toolCall.function.name,
      args: JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>,
    }))
    return { text: message?.content ?? '', toolCalls }
  }
}

export interface LiveApiConfig {
  base: string
  key: string
  model: string
  source: string
}

/**
 * Resolve a real OpenAI-compatible endpoint from env.
 * Order: DS_AGENT_API_* → DEEPSEEK_* → OPENROUTER_* → OPENAI_* → GROK_/XAI_*.
 * Returns null when nothing is configured (no silent Mock here).
 */
export function resolveLiveApi(env: NodeJS.ProcessEnv = process.env): LiveApiConfig | null {
  const modelOverride = env.DS_AGENT_API_MODEL || env.DS_AGENT_MODEL

  if (env.DS_AGENT_API_BASE && env.DS_AGENT_API_KEY) {
    return {
      base: env.DS_AGENT_API_BASE,
      key: env.DS_AGENT_API_KEY,
      model: modelOverride || 'deepseek-chat',
      source: 'DS_AGENT_API_*',
    }
  }

  if (env.DEEPSEEK_API_KEY) {
    return {
      base: env.DEEPSEEK_API_BASE || 'https://api.deepseek.com/v1',
      key: env.DEEPSEEK_API_KEY,
      model: modelOverride || env.DEEPSEEK_MODEL || 'deepseek-chat',
      source: 'DEEPSEEK_API_KEY',
    }
  }

  if (env.OPENROUTER_API_KEY) {
    return {
      base: env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1',
      key: env.OPENROUTER_API_KEY,
      model: modelOverride || env.OPENROUTER_MODEL || 'deepseek/deepseek-chat',
      source: 'OPENROUTER_API_KEY',
    }
  }

  if (env.OPENAI_API_KEY) {
    return {
      base: env.OPENAI_BASE_URL || env.OPENAI_API_BASE || 'https://api.openai.com/v1',
      key: env.OPENAI_API_KEY,
      model: modelOverride || env.OPENAI_MODEL || 'gpt-4o-mini',
      source: 'OPENAI_API_KEY',
    }
  }

  const grokKey = env.GROK_API_KEY || env.XAI_API_KEY
  if (grokKey) {
    return {
      base: env.GROK_API_BASE || env.XAI_API_BASE || 'https://api.x.ai/v1',
      key: grokKey,
      model: modelOverride || env.GROK_MODEL || env.XAI_MODEL || 'grok-2-latest',
      source: env.GROK_API_KEY ? 'GROK_API_KEY' : 'XAI_API_KEY',
    }
  }

  return null
}

export function liveApiMissingMessage(): string {
  return [
    'ds-agent demo requires a real model API key (MockModel is disabled for demo).',
    'Set one of:',
    '  DEEPSEEK_API_KEY=...                         # uses https://api.deepseek.com/v1',
    '  DS_AGENT_API_BASE=... DS_AGENT_API_KEY=...    # any OpenAI-compatible base',
    '  OPENROUTER_API_KEY=...                       # e.g. model deepseek/deepseek-chat',
    '  OPENAI_API_KEY=...',
    '  GROK_API_KEY=... or XAI_API_KEY=...',
    'Optional: DS_AGENT_API_MODEL / DEEPSEEK_MODEL / OPENROUTER_MODEL',
  ].join('\n')
}

/** Real HttpOpenAI model, or throw with setup instructions (never MockModel). */
export function requireLiveModelFromEnv(env: NodeJS.ProcessEnv = process.env): Model {
  const cfg = resolveLiveApi(env)
  if (!cfg) throw new Error(liveApiMissingMessage())
  return new HttpOpenAI(cfg.base, cfg.key, cfg.model)
}

/**
 * Prefer a live API when configured; otherwise MockModel.
 * Used by unit tests and optional CLI paths that still allow offline.
 */
export function createModelFromEnv(env: NodeJS.ProcessEnv = process.env): Model {
  const cfg = resolveLiveApi(env)
  if (cfg) return new HttpOpenAI(cfg.base, cfg.key, cfg.model)
  return new MockModel()
}

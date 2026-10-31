import { ruleClassify, type SemanticHit, type SemanticModel } from '../ingress/filter.ts'
import type { Role } from '../shared/types.ts'
import type { Trigger } from '../shared/types.ts'
import { resolveLiveApi } from './providers.ts'

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
    return 'You are a WorkerSession. Investigate with tools and report_to_router. Never message the user directly. Shell env is allowlisted (PATH, HOME, USER, LANG, TMPDIR); credential values are omitted.'
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

/** Messages from the latest user prompt through the tool results of this turn. */
export function currentTurn(messages: ModelMessage[]): ModelMessage[] {
  let start = 0
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === 'user') start = i
  }
  return messages.slice(start)
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
    // History is on the request. Scripted control follows the current user turn only.
    const turn = currentTurn(request.messages)
    const blob = blobOf(turn)
    if (request.role === 'router') return this.router(turn, blob)
    if (request.role === 'watchdog') {
      if (!used(turn, 'list_tasks')) return call('list_tasks', {})
      return { text: '[watchdog] healthy' }
    }
    return this.worker(turn, blob)
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

/** OpenAI-compatible chat completions. Posts to `{base}/chat/completions` with a Bearer token. */
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

/** MockModel when no provider is configured. A partial key/base pair throws instead of returning MockModel. */
export function createModelFromEnv(env: NodeJS.ProcessEnv = process.env): Model {
  const live = resolveLiveApi(env)
  if (!live) return new MockModel()
  return new HttpOpenAI(live.base, live.apiKey, live.model)
}

/** Live HttpOpenAI, or an error. Never returns MockModel. */
export function requireLiveModelFromEnv(env: NodeJS.ProcessEnv = process.env): HttpOpenAI {
  const live = resolveLiveApi(env)
  if (!live) throw new Error('No live model configured; refusing MockModel.')
  return new HttpOpenAI(live.base, live.apiKey, live.model)
}
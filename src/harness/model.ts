import path from 'node:path'
import { readGatewayToken } from '../gateway/token.ts'
import { ruleClassify, type SemanticHit, type SemanticModel } from '../ingress/filter.ts'
import {
  clampPolicyReason,
  DEFAULT_POLICY_TIMEOUT_MS,
  isValidSemanticHit,
  PolicyOutputError,
  type SemanticPolicy,
} from '../ingress/policy.ts'
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

/** System prompt for the opt-in Slow Path policy. One JSON object, no prose, no tools. */
const POLICY_SYSTEM_PROMPT = [
  'Classify one chat trigger for an assistant.',
  'Reply with exactly one JSON object and no prose:',
  '{"pass":boolean,"strength":"explicit"|"inferred"|"maybe","reason":string}.',
  'pass=true only when the text asks for or clearly implies action for the assistant.',
  'strength=explicit for a direct request, inferred for a clear implication, maybe for speculation.',
  'reason must be a short single-line explanation.',
].join(' ')

/** Source and address are structured hints; the text is already redacted by ingress. */
function policyUserContent(trigger: Trigger): string {
  return [
    `source=${trigger.source}`,
    `addressed=${trigger.addressed ?? 'none'}`,
    'text=',
    trigger.text,
  ].join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Parse the model's one JSON object. A surrounding Markdown fence is the only
 * tolerated decoration; missing/unknown fields, wrong types, or extra prose are
 * invalid. The thrown error never contains the response body.
 */
export function parsePolicyContent(content: string): SemanticHit {
  let raw = content.trim()
  const fenced = /^```[A-Za-z0-9_-]*\s*\n?([\s\S]*?)\n?```$/u.exec(raw)
  if (fenced) raw = fenced[1]!.trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new PolicyOutputError()
  }
  if (!isRecord(parsed)) throw new PolicyOutputError()
  const keys = Object.keys(parsed).sort()
  if (keys.join(',') !== 'pass,reason,strength') throw new PolicyOutputError()
  if (typeof parsed.pass !== 'boolean') throw new PolicyOutputError()
  if (typeof parsed.reason !== 'string') throw new PolicyOutputError()
  const hit: SemanticHit = {
    pass: parsed.pass,
    strength: parsed.strength as SemanticHit['strength'],
    reason: clampPolicyReason(parsed.reason),
  }
  if (!isValidSemanticHit(hit)) throw new PolicyOutputError()
  return hit
}


export function systemPrompt(role: Role): string {
  if (role === 'router') {
    return 'You are the MainSession. The Engine already acknowledged an accepted ticket; do not send a second acknowledgement. Speak to the user with reply_user only when a worker report delivers a result. Do not run bash. Stay quiet on speculative work until a report delivers. '
      + 'Exception: when the ticket prompt says direct-chat=true and the message is conversational (no code, file, or other deliverable), answer it briefly and naturally with reply_user in the sender\'s language, then call assess_trigger with kind=stop so no worker starts. Never leave a direct-chat message unanswered. '
      + 'Keep the conversation going: do not tell the other party to stop replying, do not announce that the test is over, and do not unilaterally close a conversation. Match their tone (casual, playful, or serious). End only when they clearly end it. '
      + 'Your default direct-chat tone is warm, playful, and cute; this overrides matching a flat tone. In casual replies when the other person is comfortable, include 1–2 emoji, a short personal reaction, and a question that is easy to answer. Follow their latest style instruction exactly and immediately — if they ask you to stop using a word, an emoji, or a tone, their preference wins over this default. Never answer like a report, and never let the chat end while the other party is still engaging. '
      + 'Be proactive: you are a proactive agent, so drive the chat — pick up on what they just said, propose a topic they might enjoy, ask a question they would actually want to answer, or offer one small concrete thing you could look up or do for them. When they go quiet, open a fresh topic or tease them gently instead of letting the conversation die.'
  }
  if (role === 'worker') {
    return 'You are an ExecutorSession. Investigate with tools and report_to_router. Never message the user directly. Shell env is allowlisted (PATH, HOME, USER, LANG, TMPDIR); credential values are omitted.'
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

/** Legacy deterministic stand-in. Demo and the default test suite must not instantiate this. */
export class MockModel implements Model, SemanticPolicy {
  readonly name = 'MockModel'

  classify(trigger: Trigger): SemanticHit {
    return ruleClassify(trigger)
  }

  /** Deterministic Slow Path policy: same rules, async to satisfy the policy port. */
  async classifyPolicy(trigger: Trigger): Promise<SemanticHit> {
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
    // No duplicate acknowledgement: Tickets.create already sent one.
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
export class HttpOpenAI implements Model, SemanticPolicy {
  readonly name = 'HttpOpenAI'
  private policyTimeoutMs: number

  constructor(
    private readonly base: string,
    private readonly apiKey: string,
    private readonly model: string,
    /** Hard per-request budget. An unanswered HTTP call must not hold a session chain. */
    private readonly timeoutMs = 60_000,
    /** Hard bound for the opt-in Slow Path call; the classifier adds its own race. */
    policyTimeoutMs = DEFAULT_POLICY_TIMEOUT_MS,
  ) {
    this.policyTimeoutMs = policyTimeoutMs
  }

  classify(trigger: Trigger): SemanticHit {
    return ruleClassify(trigger)
  }

  /** Runtime-configured Slow Path budget; also bounds the HTTP abort signal. */
  setPolicyTimeout(timeoutMs: number): void {
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) this.policyTimeoutMs = timeoutMs
  }

  /**
   * One tool-free, temperature-0 chat call that must return a strict JSON hit.
   * Only the HTTP status appears in an error; the key, request body, and model
   * output are never logged or attached to an error.
   */
  async classifyPolicy(trigger: Trigger): Promise<SemanticHit> {
    const url = `${this.base.replace(/\/$/, '')}/chat/completions`
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(this.policyTimeoutMs),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        max_tokens: 96,
        messages: [
          { role: 'system', content: POLICY_SYSTEM_PROMPT },
          { role: 'user', content: policyUserContent(trigger) },
        ],
      }),
    })
    if (!response.ok) throw new Error(`slow-path policy HTTP ${response.status}`)
    const json = await response.json() as {
      choices?: Array<{ message?: { content?: unknown } }>
    }
    const content = json.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new PolicyOutputError()
    return parsePolicyContent(content)
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    const url = `${this.base.replace(/\/$/, '')}/chat/completions`
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(this.timeoutMs),
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
          reasoning_content?: string | null
          reasoning?: string | null
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
        }
      }>
    }
    const message = json.choices?.[0]?.message
    const toolCalls: ToolCall[] = []
    let malformed = false
    for (const toolCall of message?.tool_calls ?? []) {
      try {
        toolCalls.push({
          id: toolCall.id,
          name: toolCall.function.name,
          args: JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>,
        })
      } catch {
        // One bad argument string must not reject the turn (or leave the assignment running).
        malformed = true
      }
    }
    if (malformed && toolCalls.length === 0) {
      return { text: '[model] malformed tool arguments ignored', toolCalls: [] }
    }
    // Magpie DeepSeek may return content:null with reasoning_content filled.
    const text = (message?.content
      ?? message?.reasoning_content
      ?? message?.reasoning
      ?? '') || ''
    return { text, toolCalls }
  }
}

function timeoutFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.DS_AGENT_API_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000
}

/**
 * A local gateway takes priority when `DS_AGENT_GATEWAY_URL` is set. The bearer
 * token comes from `DS_AGENT_GATEWAY_TOKEN` or the gateway's persisted 0600
 * token file, so the agent reuses the gateway's self-issued token automatically.
 */
function gatewayApiFromEnv(env: NodeJS.ProcessEnv): { base: string; apiKey: string; model: string } | undefined {
  const raw = env.DS_AGENT_GATEWAY_URL?.trim()
  if (!raw) return undefined
  const trimmed = raw.replace(/\/+$/, '')
  const base = trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
  const home = env.DS_AGENT_HOME?.trim() || path.join(process.cwd(), '.ds-agent')
  const token = env.DS_AGENT_GATEWAY_TOKEN?.trim() || readGatewayToken(home)
  if (!token) return undefined
  const model = env.DS_AGENT_GATEWAY_MODEL?.trim() || env.DS_AGENT_API_MODEL?.trim() || 'auto'
  return { base, apiKey: token, model }
}

/** MockModel when no provider is configured. A partial key/base pair throws instead of returning MockModel. */
export function createModelFromEnv(env: NodeJS.ProcessEnv = process.env): Model {
  const gateway = gatewayApiFromEnv(env)
  if (gateway) return new HttpOpenAI(gateway.base, gateway.apiKey, gateway.model, timeoutFromEnv(env))
  const live = resolveLiveApi(env)
  if (!live) return new MockModel()
  return new HttpOpenAI(live.base, live.apiKey, live.model, timeoutFromEnv(env))
}

/**
 * Per-role model ids (T07/T10). The Router can run a lighter model than the Worker.
 * Only creates a client when the corresponding DS_AGENT_*_MODEL id is set; otherwise
 * the runtime keeps one model for every role.
 */
export function roleModelsFromEnv(
  env: NodeJS.ProcessEnv,
  _fallback: Model,
): Partial<Record<Role, Model>> {
  // Role models are optional. A partial provider config (key without base) must
  // not crash a Runtime whose caller already supplied an explicit model.
  let live: ReturnType<typeof resolveLiveApi>
  try {
    live = resolveLiveApi(env)
  } catch {
    return {}
  }
  if (!live) return {}
  const ids: Record<Role, string | undefined> = {
    router: env.DS_AGENT_ROUTER_MODEL,
    worker: env.DS_AGENT_WORKER_MODEL,
    watchdog: env.DS_AGENT_WATCHDOG_MODEL,
  }
  const models: Partial<Record<Role, Model>> = {}
  for (const role of ['router', 'worker', 'watchdog'] as const) {
    const id = ids[role]
    if (id) models[role] = new HttpOpenAI(live.base, live.apiKey, id, timeoutFromEnv(env))
  }
  return models
}

/** Live HttpOpenAI (or the local gateway), or an error. Never returns MockModel. */
export function requireLiveModelFromEnv(env: NodeJS.ProcessEnv = process.env): HttpOpenAI {
  const gateway = gatewayApiFromEnv(env)
  if (gateway) return new HttpOpenAI(gateway.base, gateway.apiKey, gateway.model, timeoutFromEnv(env))
  const live = resolveLiveApi(env)
  if (!live) throw new Error('No live model configured; refusing MockModel.')
  return new HttpOpenAI(live.base, live.apiKey, live.model, timeoutFromEnv(env))
}

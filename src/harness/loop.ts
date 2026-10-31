import type { TurnResult } from '../shared/ports.js'
import { isToolStart, type SessionRole } from '../shared/types.js'
import type { Model, ModelMessage, ToolCall } from './model.js'
import type { SessionEvent, SessionLog } from './session.js'
import type { ToolRegistry } from './tools.js'

export interface LoopDeps {
  sessions: SessionLog
  model: Model
  tools: ToolRegistry
  maxSteps?: number
}

const DEFAULT_MAX_STEPS = 8

/** One async ReAct turn. A tool that returns `{ status: 'started', jobId }` ends the turn without waiting. */
export async function runTurn(sessionId: string, deps: LoopDeps): Promise<TurnResult> {
  const state = deps.sessions.get(sessionId)
  if (!state) throw new Error(`session ${sessionId} not found`)
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS
  deps.sessions.setStatus(sessionId, 'running')
  const started: TurnResult['started'] = []

  for (let step = 0; step < maxSteps; step++) {
    const response = await deps.model.complete({
      messages: toMessages(deps.sessions.restore(sessionId)),
      tools: deps.tools.schemas(state.role),
    })
    deps.sessions.append({
      sessionId,
      kind: 'assistant',
      text: response.content,
      data: response.toolCalls.length ? { toolCalls: response.toolCalls } : undefined,
    })
    if (response.toolCalls.length === 0) {
      deps.sessions.setStatus(sessionId, 'idle')
      return { sessionId, status: 'done', started }
    }

    let yielded = false
    for (const call of response.toolCalls) {
      const result = await runCall(deps, sessionId, state.role, call)
      deps.sessions.append({
        sessionId,
        kind: 'tool',
        text: JSON.stringify(result),
        name: call.name,
        toolCallId: call.id,
        data: isToolStart(result) ? { ...result } : undefined,
      })
      if (isToolStart(result)) {
        started.push(result)
        yielded = true
      }
    }
    if (yielded) {
      deps.sessions.setStatus(sessionId, 'waiting')
      return { sessionId, status: 'waiting', started }
    }
  }

  deps.sessions.append({ sessionId, kind: 'system', text: 'max steps' })
  deps.sessions.setStatus(sessionId, 'stopped')
  return { sessionId, status: 'stopped', started }
}

async function runCall(deps: LoopDeps, sessionId: string, role: SessionRole, call: ToolCall): Promise<unknown> {
  try {
    return await deps.tools.invoke(role, call.name, call.arguments, { sessionId, role, callId: call.id })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'tool failed'
    return { error: message }
  }
}

function toMessages(events: SessionEvent[]): ModelMessage[] {
  return events.map(event => {
    if (event.kind === 'assistant') {
      const toolCalls = event.data?.toolCalls
      return {
        role: 'assistant',
        content: event.text,
        ...(Array.isArray(toolCalls) ? { toolCalls: toolCalls as ModelMessage['toolCalls'] } : {}),
      }
    }
    if (event.kind === 'tool') {
      return { role: 'tool', content: event.text, toolCallId: event.toolCallId }
    }
    return { role: event.kind, content: event.text }
  })
}

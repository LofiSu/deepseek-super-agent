import type { Harness, TurnResult } from '../shared/ports.js'
import { Daemon } from './daemon.js'
import { runTurn, type LoopDeps } from './loop.js'
import type { Model } from './model.js'
import type { SessionLog } from './session.js'
import type { ToolRegistry } from './tools.js'

export class AgentHarness implements Harness {
  private readonly active = new Set<string>()

  constructor(private readonly deps: LoopDeps) {}

  async runTurn(sessionId: string): Promise<TurnResult> {
    if (this.active.has(sessionId)) {
      return { sessionId, status: 'waiting', started: [] }
    }
    this.active.add(sessionId)
    try {
      return await runTurn(sessionId, this.deps)
    } finally {
      this.active.delete(sessionId)
    }
  }

  daemon(intervalMs?: number): Daemon {
    return new Daemon({
      sessions: this.deps.sessions,
      runTurn: id => this.runTurn(id),
      intervalMs,
    })
  }
}

export interface HarnessParts {
  sessions: SessionLog
  model: Model
  tools: ToolRegistry
}

export { Daemon }
export { runTurn }
export { MockModel, HttpOpenAIModel, createModel } from './model.js'
export type { Model, ModelMessage, ModelRequest, ModelResponse, ToolCall } from './model.js'
export { SessionLog } from './session.js'
export type { SessionEvent, SessionEventKind, SessionState, SessionStatus } from './session.js'
export { ToolRegistry } from './tools.js'
export type { JsonSchema, RegisteredTool, ToolContext } from './tools.js'

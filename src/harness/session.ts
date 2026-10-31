import type { SessionRole } from '../shared/types.js'
import { AgentError } from '../shared/errors.js'

export type SessionEventKind = 'user' | 'assistant' | 'tool' | 'system'
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'stopped'

export interface SessionState {
  id: string
  role: SessionRole
  status: SessionStatus
  updatedAt: string
}

export interface SessionEvent {
  id: string
  sessionId: string
  seq: number
  kind: SessionEventKind
  at: string
  text: string
  name?: string
  toolCallId?: string
  data?: Record<string, unknown>
}

export interface NewSessionEvent {
  sessionId: string
  kind: SessionEventKind
  text?: string
  name?: string
  toolCallId?: string
  data?: Record<string, unknown>
  at?: string
}

/** Append-only session event log. Status is metadata; events are never rewritten. */
export class SessionLog {
  private readonly events = new Map<string, SessionEvent[]>()
  private readonly states = new Map<string, SessionState>()
  private seq = 0

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  create(id: string, role: SessionRole): SessionState {
    if (this.states.has(id)) throw new AgentError('session_exists', `session ${id} already exists`)
    const state: SessionState = { id, role, status: 'idle', updatedAt: this.now() }
    this.states.set(id, state)
    this.events.set(id, [])
    return { ...state }
  }

  get(id: string): SessionState | undefined {
    const state = this.states.get(id)
    return state ? { ...state } : undefined
  }

  setStatus(id: string, status: SessionStatus): SessionState {
    const state = this.states.get(id)
    if (!state) throw new AgentError('session_missing', `session ${id} not found`)
    state.status = status
    state.updatedAt = this.now()
    return { ...state }
  }

  append(input: NewSessionEvent): SessionEvent {
    const bucket = this.events.get(input.sessionId)
    if (!bucket) throw new AgentError('session_missing', `session ${input.sessionId} not found`)
    const event: SessionEvent = {
      id: `${input.sessionId}:${bucket.length + 1}`,
      sessionId: input.sessionId,
      seq: ++this.seq,
      kind: input.kind,
      at: input.at ?? this.now(),
      text: input.text ?? '',
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
    }
    bucket.push(event)
    return { ...event, data: event.data ? { ...event.data } : undefined }
  }

  /** Events in append order for one session. */
  restore(sessionId: string): SessionEvent[] {
    const bucket = this.events.get(sessionId)
    if (!bucket) throw new AgentError('session_missing', `session ${sessionId} not found`)
    return bucket.map(event => ({ ...event, data: event.data ? { ...event.data } : undefined }))
  }

  /** Sessions left running or waiting for a started job. */
  unfinished(): SessionState[] {
    return [...this.states.values()]
      .filter(state => state.status === 'running' || state.status === 'waiting')
      .map(state => ({ ...state }))
  }
}

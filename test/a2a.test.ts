import { describe, expect, it } from 'vitest'
import { a2aProblems, createA2AEnvelope } from '../src/a2a/envelope.ts'

describe('A2A envelopes', () => {
  it('accepts a version-0 task request and rejects a blank sender', () => {
    const message = createA2AEnvelope({
      id: 'a2a_1',
      type: 'task.request',
      from: { agentId: 'ds-agent', instance: 'local' },
      to: { agentId: 'other' },
      taskId: 'ticket_1',
      text: 'please look at the login timeout',
      at: '2026-10-31T00:00:00.000Z',
    })
    expect(message.version).toBe('0')
    expect(a2aProblems(message)).toEqual([])
    expect(a2aProblems({ ...message, from: { agentId: ' ' } })).toContain('from')
    expect(a2aProblems({ ...message, type: 'task.nope' as 'task.request' })).toContain('type')
  })
})

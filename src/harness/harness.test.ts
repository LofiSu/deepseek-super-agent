import { describe, expect, it } from 'vitest'
import { AgentHarness } from './index.js'
import { Daemon } from './daemon.js'
import { HttpOpenAIModel, MockModel, createModel } from './model.js'
import { SessionLog } from './session.js'
import { ToolRegistry } from './tools.js'
import type { RegisteredTool } from './tools.js'

const echo: RegisteredTool = {
  name: 'echo',
  description: 'echo text',
  roles: ['worker'],
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  async run(args) {
    return { text: args.text }
  },
}

const slow: RegisteredTool = {
  name: 'slow',
  description: 'start a job',
  roles: ['worker', 'watchdog'],
  parameters: { type: 'object' },
  async run() {
    return { status: 'started' as const, jobId: 'job-1' }
  },
}

const route: RegisteredTool = {
  name: 'route',
  description: 'router only',
  roles: ['router'],
  parameters: { type: 'object' },
  async run() {
    return { ok: true }
  },
}

describe('session log', () => {
  it('appends user, assistant, tool, and system events and restores by session id', () => {
    const log = new SessionLog(() => '2026-01-01T00:00:00.000Z')
    log.create('s1', 'worker')
    log.create('s2', 'router')
    log.append({ sessionId: 's1', kind: 'system', text: 'worker' })
    log.append({ sessionId: 's1', kind: 'user', text: 'fix the build' })
    log.append({ sessionId: 's1', kind: 'assistant', text: 'looking' })
    log.append({ sessionId: 's1', kind: 'tool', text: '{"ok":true}', name: 'echo', toolCallId: 'c1' })
    log.append({ sessionId: 's2', kind: 'user', text: 'other' })

    const restored = log.restore('s1')
    expect(restored.map(event => event.kind)).toEqual(['system', 'user', 'assistant', 'tool'])
    expect(restored.map(event => event.text)).toEqual(['worker', 'fix the build', 'looking', '{"ok":true}'])
    expect(log.restore('s2')).toHaveLength(1)
    expect(restored.map(event => event.seq)).toEqual([1, 2, 3, 4])
  })
})

describe('tools', () => {
  it('registers by role', async () => {
    const tools = new ToolRegistry()
    tools.register(echo)
    tools.register(slow)
    tools.register(route)
    expect(tools.list('worker').map(tool => tool.name)).toEqual(['echo', 'slow'])
    expect(tools.list('router').map(tool => tool.name)).toEqual(['route'])
    expect(tools.list('watchdog').map(tool => tool.name)).toEqual(['slow'])
    await expect(tools.invoke('router', 'echo', { text: 'x' }, { sessionId: 's', role: 'router', callId: 'c' })).rejects.toThrow(/not registered/)
  })
})

describe('runTurn', () => {
  it('runs a tool to completion', async () => {
    const sessions = new SessionLog(() => '2026-01-01T00:00:00.000Z')
    sessions.create('s1', 'worker')
    sessions.append({ sessionId: 's1', kind: 'system', text: 'worker' })
    sessions.append({ sessionId: 's1', kind: 'user', text: 'hi' })
    const model = new MockModel([
      { content: '', toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'hi' } }] },
      { content: 'done', toolCalls: [] },
    ])
    const tools = new ToolRegistry()
    tools.register(echo)
    const harness = new AgentHarness({ sessions, model, tools })

    const result = await harness.runTurn('s1')
    expect(result).toEqual({ sessionId: 's1', status: 'done', started: [] })
    const events = sessions.restore('s1')
    expect(events.at(-1)).toMatchObject({ kind: 'assistant', text: 'done' })
    expect(events.find(event => event.kind === 'tool')).toMatchObject({ name: 'echo', text: '{"text":"hi"}' })
    expect(model.calls).toHaveLength(2)
    expect(model.calls[0]?.messages[0]).toMatchObject({ role: 'system', content: 'worker' })
    expect(sessions.get('s1')?.status).toBe('idle')
  })

  it('does not block when a tool returns a started job', async () => {
    const sessions = new SessionLog()
    sessions.create('s1', 'worker')
    sessions.append({ sessionId: 's1', kind: 'user', text: 'run' })
    const model = new MockModel([
      { content: 'starting', toolCalls: [{ id: 'c1', name: 'slow', arguments: {} }] },
      { content: 'should not run', toolCalls: [] },
    ])
    const tools = new ToolRegistry()
    tools.register(slow)
    const harness = new AgentHarness({ sessions, model, tools })

    const result = await harness.runTurn('s1')
    expect(result.status).toBe('waiting')
    expect(result.started).toEqual([{ status: 'started', jobId: 'job-1' }])
    expect(model.calls).toHaveLength(1)
    expect(sessions.get('s1')?.status).toBe('waiting')
  })

  it('repeats MockModel output for the same script', async () => {
    const first = new MockModel()
    const second = new MockModel()
    const request = { messages: [{ role: 'user' as const, content: 'ping' }], tools: [] }
    expect(await first.complete(request)).toEqual(await second.complete(request))
    expect(await first.complete(request)).toEqual({ content: 'mock:ping', toolCalls: [] })
  })
})

describe('HttpOpenAIModel', () => {
  it('posts to the configured OpenAI-compatible endpoint', async () => {
    const seen: { url: string; authorization: string; body: unknown }[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push({
        url: String(input),
        authorization: String(new Headers(init?.headers).get('authorization')),
        body: JSON.parse(String(init?.body)),
      })
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: 'hello',
            tool_calls: [{ id: 'call-1', function: { name: 'echo', arguments: '{"text":"hi"}' } }],
          },
        }],
      }), { status: 200 })
    }
    const model = new HttpOpenAIModel({
      env: { DS_AGENT_API_BASE: 'http://models.example/v1/', DS_AGENT_API_KEY: 'secret', DS_AGENT_API_MODEL: 'test-model' },
      fetch: fetchImpl,
    })
    const response = await model.complete({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'echo', description: 'echo', parameters: { type: 'object' } }],
    })
    expect(response).toEqual({
      content: 'hello',
      toolCalls: [{ id: 'call-1', name: 'echo', arguments: { text: 'hi' } }],
    })
    expect(seen[0]).toMatchObject({
      url: 'http://models.example/v1/chat/completions',
      authorization: 'Bearer secret',
    })
    expect(seen[0]?.body).toMatchObject({ model: 'test-model' })
    expect(createModel({})).toBeInstanceOf(MockModel)
    expect(createModel({ DS_AGENT_API_BASE: 'http://models.example/v1', DS_AGENT_API_KEY: 'k' }, fetchImpl)).toBeInstanceOf(HttpOpenAIModel)
  })
})

describe('daemon', () => {
  it('resumes unfinished sessions and waits for the in-flight turn on stop', async () => {
    const sessions = new SessionLog()
    sessions.create('s1', 'worker')
    sessions.setStatus('s1', 'running')
    let release = (): void => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let started = false
    const daemon = new Daemon({
      sessions,
      intervalMs: 60_000,
      async runTurn() {
        started = true
        await gate
        sessions.setStatus('s1', 'idle')
        return { sessionId: 's1', status: 'done', started: [] }
      },
    })

    const pending = daemon.resume()
    await waitFor(() => started)
    let stopped = false
    const stopping = daemon.stop().then(() => {
      stopped = true
    })
    await delay(20)
    expect(stopped).toBe(false)
    release()
    await pending
    await stopping
    expect(stopped).toBe(true)
  })

  it('ticks while started', async () => {
    const sessions = new SessionLog()
    sessions.create('s1', 'watchdog')
    sessions.setStatus('s1', 'waiting')
    let runs = 0
    const daemon = new Daemon({
      sessions,
      intervalMs: 15,
      async runTurn() {
        runs += 1
        sessions.setStatus('s1', 'idle')
        return { sessionId: 's1', status: 'done', started: [] }
      },
    })
    daemon.start()
    await waitFor(() => runs > 0)
    await daemon.stop()
    expect(runs).toBeGreaterThan(0)
  })
})

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

async function waitFor(ready: () => boolean): Promise<void> {
  const start = Date.now()
  while (!ready()) {
    if (Date.now() - start > 1000) throw new Error('timed out waiting')
    await delay(5)
  }
}

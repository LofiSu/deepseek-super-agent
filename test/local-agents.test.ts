import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bindRolePorts } from '../src/core/role-ports.ts'
import {
  LocalAgentRegistry,
  loadLocalAgents,
  type LocalAgentSpec,
} from '../src/env/local-agents.ts'
import { LocalEnv } from '../src/env/local-env.ts'
import type { Completion, Model } from '../src/harness/model.ts'
import { ToolRegistry } from '../src/harness/tools.ts'
import { Runtime } from '../src/runtime.ts'
import type { Ticket, Trigger } from '../src/shared/types.ts'
import { ruleClassify } from '../src/ingress/filter.ts'
import { shutdown, tempHome } from './fixtures.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, 'fixtures', 'local-agent-fixture.mjs')
const cleanups: (() => Promise<void> | void)[] = []
const runtimes: Runtime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await shutdown(runtime)
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const scriptedModel: Model = {
  name: 'LocalAgentScript',
  classify(trigger: Trigger) {
    return ruleClassify(trigger)
  },
  async complete(): Promise<Completion> {
    return { text: 'ok' }
  },
}

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'ds-agent-local-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function registry(agents: LocalAgentSpec[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): LocalAgentRegistry {
  const root = opts.cwd ?? workspace()
  return new LocalAgentRegistry(agents, {
    env: opts.env ?? { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    workspace: () => root,
  })
}

function putTicket(runtime: Runtime, id: string, overrides: Partial<Ticket> = {}): Ticket {
  const ticket: Ticket = {
    id,
    title: 'delegate',
    brief: 'delegate work to a specialist',
    mandate: {
      strength: 'explicit',
      policyVersion: 'test',
      scope: 'test',
      actor: { source: 'cli', id: 'tester' },
      basis: 'addressed',
    },
    threadKeys: [],
    channels: [],
    inputs: [],
    assignments: [],
    speculative: false,
    originTriggerId: 'trigger_test',
    createdAt: '2026-11-05T00:00:00.000Z',
    ...overrides,
  }
  runtime.store.putDoc('ticket', id, ticket)
  return ticket
}

function toolsFor(runtime: Runtime): ToolRegistry {
  return new ToolRegistry({
    store: runtime.store,
    ports: bindRolePorts(runtime.engine),
    env: new LocalEnv(path.join(runtime.home, 'workspaces')),
    metrics: runtime.metrics,
    redact: text => text,
    log: () => {},
    scheduleJob: () => {},
    routerTurn: async () => {},
    localAgents: runtime.localAgents,
  })
}

function echoAgent(extra: Partial<LocalAgentSpec> = {}): LocalAgentSpec {
  return {
    id: 'echo',
    command: process.execPath,
    args: [fixture, 'echo', '{task}'],
    description: 'Echo the task',
    timeoutMs: 5_000,
    ...extra,
  }
}

describe('local agent configuration', () => {
  it('loads agents from local-agents.json and falls back to the environment', () => {
    const home = tempHome()
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }))
    fs.writeFileSync(path.join(home, 'local-agents.json'), JSON.stringify({
      agents: [{ id: 'file-agent', command: process.execPath, args: ['-e', ''] }],
    }))
    const fromFile = loadLocalAgents(home, {
      DS_AGENT_LOCAL_AGENTS: JSON.stringify([{ id: 'env-agent', command: process.execPath }]),
    })
    expect(fromFile.map(agent => agent.id)).toEqual(['file-agent'])

    const fromEnv = loadLocalAgents(tempHome(), {
      DS_AGENT_LOCAL_AGENTS: JSON.stringify([{ id: 'env-agent', command: process.execPath }]),
    })
    expect(fromEnv.map(agent => agent.id)).toEqual(['env-agent'])
  })

  it('rejects duplicate ids, bad commands, and unknown config keys', () => {
    const home = tempHome()
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }))
    fs.writeFileSync(path.join(home, 'local-agents.json'), JSON.stringify({
      agents: [
        { id: 'dup', command: process.execPath },
        { id: 'dup', command: process.execPath },
      ],
    }))
    expect(() => loadLocalAgents(home, {})).toThrow(/duplicate/)

    expect(() => loadLocalAgents(tempHome(), {
      DS_AGENT_LOCAL_AGENTS: JSON.stringify([{ id: 'bad', command: 'claude; rm -rf /' }]),
    })).toThrow(/command/)

    expect(() => loadLocalAgents(tempHome(), {
      DS_AGENT_LOCAL_AGENTS: JSON.stringify([{ id: 'bad', command: process.execPath, shell: true }]),
    })).toThrow(/unknown/)
  })

  it('treats a blank file as no agents instead of invalid JSON', () => {
    const home = tempHome()
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }))
    fs.writeFileSync(path.join(home, 'local-agents.json'), '  \n')
    const env = { DS_AGENT_LOCAL_AGENTS: JSON.stringify([{ id: 'env-agent', command: process.execPath }]) }
    // The file wins, so a deliberately blank file also disables env agents.
    expect(loadLocalAgents(home, env)).toEqual([])
  })

  it('accepts ~/ commands and rejects option-shaped bare names', () => {
    const home = tempHome()
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }))
    fs.writeFileSync(path.join(home, 'local-agents.json'), JSON.stringify({
      agents: [{ id: 'home-agent', command: '~/bin/agent' }],
    }))
    expect(loadLocalAgents(home, {})[0]?.command).toBe(path.join(os.homedir(), 'bin', 'agent'))

    expect(() => loadLocalAgents(tempHome(), {
      DS_AGENT_LOCAL_AGENTS: JSON.stringify([{ id: 'opt', command: '-rf' }]),
    })).toThrow(/command/)
  })
})

describe('local agent execution', () => {
  it('passes the task as one argv entry, runs in the worker workspace, and never uses a shell', async () => {
    const cwd = workspace()
    const task = 'fix the flaky test; $(touch pwned) && echo nope'
    const result = await registry([echoAgent()], { cwd }).run('echo', task, 'worker_1')
    expect(result.code).toBe(0)
    const parsed = JSON.parse(result.stdout) as { args: string[]; cwd: string }
    expect(parsed.args).toEqual(['echo', task])
    expect(parsed.cwd).toBe(fs.realpathSync(cwd))
    expect(fs.existsSync(path.join(cwd, 'pwned'))).toBe(false)
  })

  it('appends the task when the configured args have no placeholder', async () => {
    const result = await registry([echoAgent({ args: [fixture, 'echo'] })]).run('echo', 'hello', 'worker_1')
    const parsed = JSON.parse(result.stdout) as { args: string[] }
    expect(parsed.args).toEqual(['echo', 'hello'])
  })

  it('kills a timed-out agent and reports it', async () => {
    const result = await registry([echoAgent({ args: [fixture, 'slow'], timeoutMs: 150 })]).run('echo', 'wait', 'worker_1')
    expect(result.timedOut).toBe(true)
    expect(result.code).not.toBe(0)
  })

  it('caps captured output instead of buffering without bound', async () => {
    const result = await registry([
      echoAgent({ args: [fixture, 'noisy'], maxOutputBytes: 500 }),
    ]).run('echo', 'noisy', 'worker_1')
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(500)
  })

  it('passes only allowlisted environment names plus the agent opt-in list', async () => {
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DS_AGENT_FIXTURE_TOKEN: 'token-value',
      UNRELATED_SECRET: 'do-not-pass',
    }
    const result = await registry([
      echoAgent({ args: [fixture, 'env'], env: ['DS_AGENT_FIXTURE_TOKEN'] }),
    ], { env }).run('echo', 'show', 'worker_1')
    expect(result.stdout).toBe('token-value')

    const hidden = await registry([
      echoAgent({ args: [fixture, 'env'] }),
    ], { env }).run('echo', 'show', 'worker_1')
    expect(hidden.stdout).toBe('missing')
  })

  it('rejects an unknown agent id with the configured ids', async () => {
    await expect(registry([echoAgent()]).run('nope', 'task', 'worker_1')).rejects.toThrow(/unknown local agent nope.*echo/i)
  })

  it('reports a missing binary as a user error rather than crashing', async () => {
    const registryUnderTest = registry([echoAgent({ command: 'definitely-not-a-real-agent-binary' })])
    await expect(registryUnderTest.run('echo', 'task', 'worker_1')).rejects.toThrow(/could not start/)
  })

  it('refuses a task that starts with a dash instead of passing it as an option', async () => {
    await expect(
      registry([echoAgent()]).run('echo', '  --dangerously-skip-permissions', 'worker_1'),
    ).rejects.toThrow(/option/)
  })

  it('keeps replacement-string patterns in the task literal', async () => {
    const task = "run sed 's/x/[$&]/g' and keep $` and $' intact"
    const result = await registry([echoAgent()]).run('echo', task, 'worker_1')
    const parsed = JSON.parse(result.stdout) as { args: string[] }
    expect(parsed.args).toEqual(['echo', task])
  })

  it('does not rewrite a task that contains a workspace placeholder', async () => {
    const cwd = workspace()
    const result = await registry([echoAgent()], { cwd }).run('echo', 'literal {workspace} text', 'worker_1')
    const parsed = JSON.parse(result.stdout) as { args: string[] }
    expect(parsed.args).toEqual(['echo', 'literal {workspace} text'])
  })

  it('kills running children on shutdown', async () => {
    const registryUnderTest = registry([echoAgent({ args: [fixture, 'slow'], timeoutMs: 60_000 })])
    const pending = registryUnderTest.run('echo', 'wait', 'worker_1')
    for (let i = 0; i < 100 && registryUnderTest.activeCount === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(registryUnderTest.activeCount).toBe(1)
    registryUnderTest.killAll()
    await expect(registryUnderTest.run('echo', 'after shutdown', 'worker_1')).rejects.toThrow(/shut down/)
    const result = await pending
    expect(result.timedOut).toBe(false)
    expect(result.code).not.toBe(0)
    expect(registryUnderTest.activeCount).toBe(0)
  })
})

describe('local agent tools', () => {
  it('exposes delegate_agent to workers and list_local_agents to both roles', async () => {
    const runtime = Runtime.create({
      home: tempHome(),
      model: scriptedModel,
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      localAgents: [echoAgent()],
    })
    runtimes.push(runtime)
    const tools = new ToolRegistry({
      store: runtime.store,
      ports: bindRolePorts(runtime.engine),
      env: new LocalEnv(path.join(runtime.home, 'workspaces')),
      metrics: runtime.metrics,
      redact: text => text,
      log: () => {},
      scheduleJob: () => {},
      routerTurn: async () => {},
      localAgents: runtime.localAgents,
    })
    const workerSpecs = (await tools.specsFor('worker')).map(spec => spec.name)
    const routerSpecs = (await tools.specsFor('router')).map(spec => spec.name)
    expect(workerSpecs).toContain('delegate_agent')
    expect(workerSpecs).toContain('list_local_agents')
    expect(routerSpecs).toContain('list_local_agents')
    expect(routerSpecs).not.toContain('delegate_agent')

    const listed = await tools.invoke(
      { id: 'l1', name: 'list_local_agents', args: {} },
      { sessionId: 'router', role: 'router' },
    ) as { agents: { id: string; description?: string }[] }
    expect(listed.agents).toEqual([{ id: 'echo', description: 'Echo the task' }])

    await expect(tools.invoke(
      { id: 'd1', name: 'delegate_agent', args: { agent: 'echo', task: 'hello' } },
      { sessionId: 'router', role: 'router' },
    )).rejects.toThrow(/not available to router/)
  })

  it('runs a configured agent for a worker and returns its output', async () => {
    const runtime = Runtime.create({
      home: tempHome(),
      model: scriptedModel,
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      localAgents: [echoAgent()],
    })
    runtimes.push(runtime)
    putTicket(runtime, 'ticket_9')
    const tools = toolsFor(runtime)
    const result = await tools.invoke(
      { id: 'd2', name: 'delegate_agent', args: { agent: 'echo', task: 'do the thing' } },
      { sessionId: 'worker_ticket_9', role: 'worker', ticketId: 'ticket_9' },
    ) as { agent: string; code: number; stdout: string }
    expect(result.agent).toBe('echo')
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).args).toEqual(['echo', 'do the thing'])
  })

  it('refuses delegation without an active, non-speculative ticket', async () => {
    const runtime = Runtime.create({
      home: tempHome(),
      model: scriptedModel,
      jobDelayMs: 0,
      watchdogIntervalMs: 60_000,
      localAgents: [echoAgent()],
    })
    runtimes.push(runtime)
    const tools = toolsFor(runtime)
    const call = (ticketId?: string) => tools.invoke(
      { id: 'd3', name: 'delegate_agent', args: { agent: 'echo', task: 'do the thing' } },
      { sessionId: 'worker_any', role: 'worker', ...(ticketId ? { ticketId } : {}) },
    )

    await expect(call()).rejects.toThrow(/active ticket/)
    await expect(call('ticket_missing')).rejects.toThrow(/active ticket/)

    putTicket(runtime, 'ticket_ended', {
      ended: { at: '2026-11-05T00:00:01.000Z', outcome: 'done', by: 'executor' },
    })
    await expect(call('ticket_ended')).rejects.toThrow(/has ended/)

    putTicket(runtime, 'ticket_spec', { speculative: true })
    await expect(call('ticket_spec')).rejects.toThrow(/speculative/)
  })
})

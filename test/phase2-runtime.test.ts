import { afterEach, describe, expect, it } from 'vitest'
import { githubTrigger } from '../src/channels/github.ts'
import { imTrigger } from '../src/channels/im.ts'
import { isPhase2Enabled, Phase2NotImplementedError } from '../src/phase2/index.ts'
import type { Runtime } from '../src/runtime.ts'
import type { Ticket } from '../src/shared/types.ts'
import { freshRuntime, settleWithDeadline, shutdown } from './fixtures.ts'

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

function envWithoutPhase2(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.DS_AGENT_PHASE2
  return env
}

describe('DS_AGENT_PHASE2 flag', () => {
  it('accepts common truthy values and treats everything else as off', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' 1 ']) {
      expect(isPhase2Enabled({ DS_AGENT_PHASE2: value })).toBe(true)
    }
    for (const value of [undefined, '', '0', 'false', 'off', 'no']) {
      expect(isPhase2Enabled({ DS_AGENT_PHASE2: value })).toBe(false)
    }
    expect(isPhase2Enabled({})).toBe(false)
  })
})

describe('Runtime Phase-2 opt-in', () => {
  it('leaves the default path untouched when the flag is unset', async () => {
    runtime = freshRuntime({ env: envWithoutPhase2() })
    expect(runtime.phase2).toBeUndefined()
    expect(runtime.log.text()).not.toContain('[phase2]')

    expect(runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    await settleWithDeadline(runtime, 90_000)
    expect(runtime.store.listDocs<Ticket>('ticket').length).toBeGreaterThan(0)
    expect(runtime.log.text()).toContain('Tickets.create')
  })

  it('leaves the default path untouched when RuntimeOptions.phase2 is false', async () => {
    runtime = freshRuntime({ env: { ...envWithoutPhase2(), DS_AGENT_PHASE2: '1' }, phase2: false })
    expect(runtime.phase2).toBeUndefined()
    expect(runtime.log.text()).not.toContain('[phase2]')
  })

  it('exposes callable Phase-2 helpers when DS_AGENT_PHASE2=1', () => {
    runtime = freshRuntime({ env: { ...envWithoutPhase2(), DS_AGENT_PHASE2: '1' } })
    const phase2 = runtime.phase2
    expect(phase2).toBeDefined()
    if (!phase2) throw new Error('phase2 registries were not constructed')
    expect(runtime.log.text()).toContain('[phase2] opt-in registries enabled')

    const im = imTrigger({ thread: 'topic/chat', text: 'hello' })
    expect(() => phase2.route(im)).not.toThrow(Phase2NotImplementedError)
    expect(phase2.route(im)).toEqual(['default'])
    phase2.routerShards.register({ id: 'github', filter: 'source:github' })
    expect(phase2.route(githubTrigger({ pr: 42, text: 'CI failed' }))).toEqual(['github'])

    const mesh = phase2.workerMesh({ id: 'worker-1', capacity: 1 })
    expect(mesh.pickNode('ticket_1')?.id).toBe('worker-1')
    expect(mesh.pickNode('ticket_2')).toBeUndefined()

    const delivered: unknown[] = []
    phase2.productShellBus.subscribe('notice', event => delivered.push(event))
    const event = { kind: 'notice', payload: { text: 'hi' } }
    expect(phase2.productShell(event)).toBe(event)
    expect(delivered).toEqual([event])

    const envelopes: unknown[] = []
    phase2.a2aRouter.register('worker-1', envelope => envelopes.push(envelope))
    const envelope = { from: 'router', to: 'worker-1', body: 'work' }
    expect(phase2.a2a(envelope)).toBe(envelope)
    expect(envelopes).toEqual([envelope])

    const saved = phase2.longTermMemory.put('ticket_1', 'auth token expired on login')
    expect(phase2.longTermMemory.query({ ticketId: 'ticket_2', text: 'token expired' }))
      .toEqual([saved])
  })

  it('can be enabled explicitly through RuntimeOptions.phase2', () => {
    runtime = freshRuntime({ env: envWithoutPhase2(), phase2: true })
    expect(runtime.phase2).toBeDefined()
    expect(runtime.log.text()).toContain('[phase2] opt-in registries enabled')
  })
})

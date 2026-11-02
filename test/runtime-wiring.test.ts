import { afterEach, describe, expect, it } from 'vitest'
import { githubTrigger } from '../src/channels/github.ts'
import { imTrigger } from '../src/channels/im.ts'
import type { Runtime } from '../src/runtime.ts'
import type { Ticket } from '../src/shared/types.ts'
import { freshRuntime, settleWithDeadline, shutdown } from './fixtures.ts'

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

describe('Runtime services', () => {
  it('builds routing, mesh, memory, lifecycle, and A2A services on the default path', () => {
    runtime = freshRuntime()
    expect(runtime.log.text()).toContain('[runtime] instance=local')
    expect(runtime.routerShards).toBeDefined()
    expect(runtime.workerMesh).toBeDefined()
    expect(runtime.longTermMemory).toBeDefined()
    expect(runtime.lifecycle).toBeDefined()
    expect(runtime.a2aRouter).toBeDefined()
    expect(runtime.routerShards.route(imTrigger({ thread: 'topic/chat', text: 'hello' })))
      .toEqual(['default'])
  })

  it('ingests and runs a ticket with the default service wiring', async () => {
    runtime = freshRuntime()
    expect(runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    await settleWithDeadline(runtime, 90_000)
    expect(runtime.store.listDocs<Ticket>('ticket').length).toBeGreaterThan(0)
    expect(runtime.log.text()).toContain('Tickets.create')
    expect(runtime.log.text()).toContain('[routing] shards=default')
  })

  it('accepts programmatic shards, instance id, and mesh capacity', () => {
    runtime = freshRuntime({
      instanceId: 'alpha',
      meshCapacity: 2,
      routerShards: [{ id: 'github', filter: 'source:github', priority: 10 }],
    })
    expect(runtime.log.text()).toContain('instance=alpha meshCapacity=2')
    expect(runtime.routerShards.route(githubTrigger({ pr: 42, text: 'CI failed' }))).toEqual(['github'])
    expect(runtime.workerMesh.list()).toEqual([{ id: 'alpha', capacity: 2, online: true }])
    expect(runtime.workerMesh.pickNode('ticket_1')?.id).toBe('alpha')
    expect(runtime.workerMesh.pickNode('ticket_2')?.id).toBe('alpha')
    expect(runtime.workerMesh.pickNode('ticket_3')).toBeUndefined()
  })

  it('publishes lifecycle events and routes local envelopes', () => {
    runtime = freshRuntime({ instanceId: 'alpha' })
    const received: unknown[] = []
    runtime.lifecycle.subscribe('notice', event => received.push(event))
    const event = { kind: 'notice', payload: { text: 'hi' } }
    expect(runtime.lifecycle.publish(event)).toBe(event)
    expect(received).toEqual([event])

    const envelopes: unknown[] = []
    runtime.a2aRouter.register('worker-1', envelope => envelopes.push(envelope))
    const envelope = { from: 'router', to: 'worker-1', body: 'work' }
    expect(runtime.a2aRouter.route(envelope)).toBe(envelope)
    expect(envelopes).toEqual([envelope])

    const saved = runtime.longTermMemory.put('ticket_1', 'auth token expired on login')
    expect(runtime.longTermMemory.query({ ticketId: 'ticket_2', text: 'token expired' }))
      .toEqual([saved])
  })
})

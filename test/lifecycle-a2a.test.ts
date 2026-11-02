import { describe, expect, it } from 'vitest'
import { A2ARouter } from '../src/channels/a2a.ts'
import { LifecycleBus } from '../src/core/lifecycle.ts'

describe('Lifecycle bus', () => {
  it('delivers events by kind and records them in order', () => {
    const bus = new LifecycleBus()
    const received: unknown[] = []
    const unsubscribe = bus.subscribe('notice', event => received.push(event))
    const first = { kind: 'notice', payload: { text: 'hello' } }
    const second = { kind: 'other', payload: 2 }
    bus.publish(first)
    bus.publish(second)
    unsubscribe()
    bus.publish(first)
    expect(received).toEqual([first])
    expect(bus.history).toEqual([first, second, first])
  })

  it('gives a panel a bounded snapshot without a Session', () => {
    const bus = new LifecycleBus()
    bus.publish({ kind: 'a', payload: 1 })
    bus.publish({ kind: 'b', payload: 2 })
    expect(bus.snapshot(1)).toEqual([{ kind: 'b', payload: 2 }])
  })
})

describe('A2A', () => {
  it('routes only to the addressed recipient and records all envelopes', () => {
    const router = new A2ARouter()
    const received: unknown[] = []
    const unregister = router.register('worker-a', envelope => received.push(envelope))
    const addressed = { from: 'router', to: 'worker-a', body: 'work' }
    const unmatched = { from: 'router', to: 'worker-b', body: 'other' }
    router.route(addressed)
    router.route(unmatched)
    unregister()
    router.route(addressed)
    expect(received).toEqual([addressed])
    expect(router.history).toEqual([addressed, unmatched, addressed])
  })

  it('reports delivery, unroutable, and handler failure separately', () => {
    const router = new A2ARouter()
    router.register('worker-a', () => {})
    expect(router.send({ from: 'router', to: 'worker-a', body: 'work' }).status).toBe('delivered')
    expect(router.send({ from: 'router', to: 'nobody', body: 'work' }).status).toBe('unroutable')
    router.register('worker-b', () => { throw new Error('boom') })
    const failed = router.send({ from: 'router', to: 'worker-b', body: 'work' })
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('boom')
  })

  it('rejects invalid envelopes', () => {
    const router = new A2ARouter()
    expect(() => router.send({ from: '', to: 'a', body: null })).toThrow(/from address/)
    expect(() => router.send({ from: 'a', to: 'b', body: 'x'.repeat(70_000) })).toThrow(/exceeds/)
  })
})

import { describe, expect, it } from 'vitest'
import { A2ARouter, ProductShellBus, phase2 } from '../src/phase2/index.ts'

describe('Phase-2 product shell', () => {
  it('delivers events by kind and records them in order', () => {
    const bus = new ProductShellBus()
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

  it('keeps the phase2 entry point opt-in', () => {
    const event = { kind: 'open', payload: null }
    expect(phase2.productShell(event)).toBe(event)
  })
})

describe('Phase-2 A2A', () => {
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

  it('accepts envelopes through the phase2 entry point', () => {
    const envelope = { from: 'a', to: 'b', body: null }
    expect(phase2.a2a(envelope)).toBe(envelope)
  })
})

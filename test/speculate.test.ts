import { afterEach, describe, expect, it } from 'vitest'
import { githubTrigger } from '../src/channels/github.ts'
import { imTrigger } from '../src/channels/im.ts'
import { Engine } from '../src/core/engine.ts'
import type { Runtime } from '../src/runtime.ts'
import type { Ticket } from '../src/shared/types.ts'
import { evaluateDeliver, visibleTickets } from '../src/speculate/gate.ts'
import { Store } from '../src/store/sqlite.ts'
import { freshRuntime, shutdown, tempHome } from './fixtures.ts'

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

function openEngine(lines: string[]): { store: Store; engine: Engine } {
  const store = new Store(tempHome())
  const engine = new Engine({
    repo: store,
    log: line => lines.push(line),
    now: () => '2026-10-31T00:00:00.000Z',
    scope: { admit: () => ({ listened: true, reason: 'test' }) },
  })
  return { store, engine }
}

function ticketIdOf(store: Store): string {
  const ticket = store.listDocs<Ticket>('ticket')[0]
  if (!ticket) throw new Error('missing ticket')
  return ticket.id
}

describe('deliver gate', () => {
  it('names deliver, discard, and hold without treating the word ready as value', () => {
    expect(evaluateDeliver({
      speculative: true,
      kind: 'ready',
      text: 'ready: investigation recorded',
      deliver: true,
    })).toBe('deliver')
    expect(evaluateDeliver({
      speculative: true,
      kind: 'ready',
      text: 'ready to look around',
      deliver: true,
    })).toBe('discard')
    expect(evaluateDeliver({
      speculative: true,
      kind: 'failed',
      text: 'reproduced the crash',
      deliver: true,
    })).toBe('discard')
    expect(evaluateDeliver({
      speculative: true,
      kind: 'progress',
      text: 'fixed the flake',
      deliver: true,
    })).toBe('hold')
    expect(evaluateDeliver({
      speculative: false,
      kind: 'failed',
      text: 'stuck',
      deliver: false,
    })).toBe('hold')
  })

  it('hides a speculative ticket until a valuable ready report, and discards the rest with no reply', () => {
    const lines: string[] = []
    const { store, engine } = openEngine(lines)
    try {
      engine.receive(githubTrigger({
        id: 'trg_hold',
        pr: 7,
        text: 'might be a flaky payment test, not sure it is ours',
        speculate: true,
      }))
      engine.evaluateDue()
      const heldId = ticketIdOf(store)
      expect(engine.report(heldId, { kind: 'progress', text: 'looking quietly', deliver: false })).toMatchObject({
        surfaced: false,
        gate: 'hold',
      })
      expect(store.getDoc<Ticket>('ticket', heldId)?.speculative).toBe(true)
      expect(store.getDoc<Ticket>('ticket', heldId)?.ended).toBeUndefined()
      expect(visibleTickets(store.listDocs<Ticket>('ticket'))).toEqual([])
      expect(visibleTickets(store.listDocs<Ticket>('ticket'), true)).toHaveLength(1)

      expect(engine.report(heldId, { kind: 'ready', text: 'ready to look around', deliver: true })).toMatchObject({
        surfaced: false,
        gate: 'discard',
      })
      const discarded = store.getDoc<Ticket>('ticket', heldId)
      expect(discarded?.speculative).toBe(true)
      expect(discarded?.ended?.outcome).toBe('ready')
      expect(store.listReplies()).toEqual([])
      expect(lines.join('\n')).toContain(`[speculate] speculative silent ticketId=${heldId}`)
      expect(lines.join('\n')).toContain(`[speculate] discard ticketId=${heldId}`)
      expect(lines.join('\n')).not.toContain('deliver=true')

      engine.receive(githubTrigger({
        id: 'trg_value',
        pr: 8,
        text: 'might be a flaky payment test, not sure it is ours',
        speculate: true,
      }))
      engine.evaluateDue()
      const valuableId = store.listDocs<Ticket>('ticket').find(ticket => ticket.id !== heldId)?.id
      if (!valuableId) throw new Error('missing valuable ticket')
      expect(engine.report(valuableId, {
        kind: 'ready',
        text: 'reproduced the flake and recorded a fix',
        deliver: true,
      })).toMatchObject({ surfaced: true, gate: 'deliver' })
      const delivered = store.getDoc<Ticket>('ticket', valuableId)
      expect(delivered?.speculative).toBe(false)
      expect(delivered?.ended?.outcome).toBe('ready')
      expect(delivered?.ended?.by).toBe('executor')
      expect(visibleTickets(store.listDocs<Ticket>('ticket')).map(ticket => ticket.id)).toEqual([valuableId])
      expect(store.listReplies()).toEqual([])
      expect(lines.join('\n')).toContain(`[speculate] deliver=true ticketId=${valuableId}`)
    } finally {
      store.close()
    }
  })

  it('still ends a normal failed assignment when the watchdog asks not to deliver', () => {
    const lines: string[] = []
    const { store, engine } = openEngine(lines)
    try {
      engine.receive(imTrigger({
        id: 'trg_login',
        thread: 'topic/bug-login',
        text: '@ds-agent please fix the login timeout',
      }))
      engine.evaluateDue()
      const id = ticketIdOf(store)
      expect(engine.report(id, { kind: 'failed', text: 'watchdog: stuck', deliver: false })).toMatchObject({
        surfaced: false,
        gate: 'hold',
      })
      const ticket = store.getDoc<Ticket>('ticket', id)
      expect(ticket?.speculative).toBe(false)
      expect(ticket?.ended).toMatchObject({ outcome: 'failed', by: 'watchdog' })
      expect(lines.join('\n')).not.toContain('deliver=true')
    } finally {
      store.close()
    }
  })

  it('delivers a scripted speculative investigation once the report has a value signal', async () => {
    runtime = freshRuntime()
    runtime.ingest(githubTrigger({
      id: 'trg_maybe',
      pr: 99,
      text: 'might be a flaky payment test, not sure it is ours',
      speculate: true,
    }))
    await runtime.jobsSettled()
    const ticket = runtime.store.listDocs<Ticket>('ticket')[0]
    expect(ticket?.speculative).toBe(false)
    expect(ticket?.ended?.outcome).toBe('ready')
    const text = runtime.log.text()
    expect(text).toContain(`speculative silent ticketId=${ticket?.id}`)
    expect(text).toContain(`deliver=true ticketId=${ticket?.id}`)
    expect(text).not.toContain('deliver withheld')
    const replies = runtime.store.listReplies().filter(reply => reply.ticketId === ticket?.id)
    expect(replies.some(reply => reply.purpose === 'acknowledgement')).toBe(false)
    expect(replies.some(reply => reply.purpose === 'result')).toBe(true)
  })
})

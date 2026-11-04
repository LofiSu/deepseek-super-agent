import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { readObjectFor } from '../src/memory/acl.ts'
import type { Runtime } from '../src/runtime.ts'
import type { Ticket, Trigger } from '../src/shared/types.ts'
import { freshRuntime, shutdown, tempHome } from './fixtures.ts'
import { silentModel } from './scripted-model.ts'

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

describe('trigger chain of recall', () => {
  it('keeps the full spilled trigger body reachable from its handle', () => {
    runtime = freshRuntime({ home: tempHome(), model: silentModel(), jobDelayMs: 0 })
    const text = `${'CI failed on auth test. '.repeat(20)}THE_END`
    runtime.ingest(imTrigger({ id: 'trg_long_body', thread: 'topic/long', text }))

    const trigger = runtime.store.getDoc<Trigger>('trigger', 'trg_long_body')
    expect(trigger).toBeTruthy()
    expect(trigger!.text).toContain('spillId=')
    const self = trigger!.refs?.find(ref => ref.kind === 'trigger')
    expect(self?.spillId).toBeTruthy()
    expect(runtime.store.getSpill(self!.spillId!)).toBe(text)

    runtime.store.putDoc('ticket', 'ticket_reader', {
      id: 'ticket_reader',
      threadKeys: ['im:topic/long'],
    } as Ticket)
    const page = readObjectFor(runtime.store, 'trigger:trg_long_body', { ticketId: 'ticket_reader' })
    expect(page.total).toBe(text.length)
    let body = page.text
    let next = page.nextOffset
    while (next != null) {
      const more = readObjectFor(
        runtime.store,
        'trigger:trg_long_body',
        { ticketId: 'ticket_reader' },
        { offset: next },
      )
      body += more.text
      next = more.nextOffset
    }
    expect(body).toBe(text)
  })
})

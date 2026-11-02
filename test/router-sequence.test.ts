import { describe, expect, it } from 'vitest'
import { MockModel, type CompletionRequest } from '../src/harness/model.ts'
import { Runtime } from '../src/runtime.ts'
import type { Ticket } from '../src/shared/types.ts'
import { tempHome } from './fixtures.ts'

describe('Router sequence point', () => {
  it('does not start the Worker before the Router turn finishes', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    class SlowRouter extends MockModel {
      override async complete(request: CompletionRequest) {
        if (request.role === 'router') await gate
        return super.complete(request)
      }
    }
    const runtime = Runtime.create({ home: tempHome(), model: new SlowRouter() })
    runtime.ingest({
      id: 't1', source: 'cli', threads: [{ source: 'cli', id: 'thread' }],
      actor: { source: 'cli', id: 'user' }, human: true, addressed: 'direct',
      at: new Date().toISOString(), text: 'please fix this error', meta: {},
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect((runtime.store.listDocs<Ticket>('ticket')[0]?.assignments[0]?.state)).toBe('pending')
    release()
    await runtime.jobsSettled()
    expect(runtime.log.text()).toContain('Assignments.start ticketId=ticket_1')
    runtime.store.close()
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { steerTrigger, waitingForHuman } from '../src/cli/steer.ts'
import type { Runtime } from '../src/runtime.ts'
import type { Ticket } from '../src/shared/types.ts'
import { freshRuntime, shutdown } from './fixtures.ts'

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

function waitingTicket(): Ticket {
  return {
    id: 'ticket_9',
    title: 'login',
    brief: 'login',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-v1',
      scope: 'login',
      actor: { source: 'cli', id: 'you' },
      basis: 'addressed',
    },
    threadKeys: ['cli:local'],
    channels: [],
    inputs: [],
    assignments: [{
      id: 'asg_1',
      state: 'running',
      speculative: false,
      report: { kind: 'waiting', text: 'which log?' },
    }],
    speculative: false,
    originTriggerId: 'trg_1',
    createdAt: '2026-10-31T00:00:00.000Z',
  }
}

describe('mid-task steer', () => {
  it('lists waiting reports and drops ended tickets', () => {
    const open = waitingTicket()
    expect(waitingForHuman([open])).toEqual([
      { ticketId: 'ticket_9', title: 'login', text: 'which log?' },
    ])
    expect(waitingForHuman([{
      ...open,
      ended: { at: '2026-10-31T00:01:00.000Z', outcome: 'ready', by: 'executor' },
    }])).toEqual([])
  })

  it('delivers a human follow-up onto the live ticket', async () => {
    runtime = freshRuntime()
    runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    const ticket = runtime.store.listDocs<Ticket>('ticket')[0]
    expect(ticket).toBeTruthy()
    runtime.ingest(steerTrigger(ticket!, 'focus on the auth test', 'trg_steer_1'))
    await runtime.jobsSettled()
    const updated = runtime.store.getDoc<Ticket>('ticket', ticket!.id)
    expect(updated?.inputs.some(input => input.text?.includes('focus on the auth test'))).toBe(true)
    const logged = runtime.log.text()
    expect(logged).toContain('bypass=subscription')
    expect(logged).toContain('trg_steer_1')
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import type { Decision, Thread } from '../src/shared/types.ts'
import type { Runtime } from '../src/runtime.ts'
import { freshRuntime, shutdown } from './fixtures.ts'

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

describe('subscription bypass', () => {
  it('fans a same-thread follow-up out with bypass=subscription and does not open a second ticket', async () => {
    runtime = freshRuntime()
    expect(runtime.ingest(imTrigger({
      id: 'trg_noise',
      thread: 'topic/chatter',
      text: 'lol nice weather today haha',
      addressed: false,
    }))).toBe('filtered')
    expect(runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    expect(runtime.ingest(imTrigger({
      id: 'trg_login_2',
      thread: 'topic/bug-login',
      text: '@ds-agent login still 500, the timeout is back',
    }))).toBe('stored')

    const tickets = runtime.store.listDocs<{ id: string; threadKeys: string[] }>('ticket')
    expect(tickets).toHaveLength(1)
    const ticketId = tickets[0]!.id
    const text = runtime.log.text()
    expect(text).toContain(`bypass=subscription ticketId=${ticketId}`)
    expect(text).toContain('ticketId=')
    const thread = runtime.store.getDoc<Thread>('thread', 'im:topic/bug-login')
    expect(thread?.pending).toEqual([])
    expect(thread?.subscriptions).toEqual([ticketId])
    const accepts = runtime.store.listDocs<Decision>('decision').filter(decision => decision.kind === 'accept')
    expect(accepts).toHaveLength(1)
    await runtime.finish()
  })
})

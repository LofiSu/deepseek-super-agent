import { describe, expect, it } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { compareLayers } from '../src/compare/layers.ts'

describe('dual-layer comparison', () => {
  it('keeps a router session on the dual arm only', async () => {
    const result = await compareLayers([
      imTrigger({
        id: 'trg_noise',
        thread: 'topic/chatter',
        text: 'lol nice weather today haha',
        addressed: false,
      }),
      imTrigger({
        id: 'trg_login',
        thread: 'topic/bug-login',
        text: '@ds-agent please fix the login timeout on checkout',
      }),
    ])
    expect(result.note).toContain('MockModel')
    expect(result.sameTicketCount).toBe(true)
    expect(result.dual.tickets).toBe(1)
    expect(result.single.tickets).toBe(1)
    expect(result.dual.routerSessions).toBe(1)
    expect(result.single.routerSessions).toBe(0)
    expect(result.dual.workerSessions).toBeGreaterThan(0)
    expect(result.single.workerSessions).toBeGreaterThan(0)
    expect(result.dual.replies).toBeGreaterThan(0)
    expect(result.single.replies).toBeGreaterThan(0)
    expect(result.dual.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(result.single.elapsedMs).toBeGreaterThanOrEqual(0)
  })
})

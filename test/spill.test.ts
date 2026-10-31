import { afterEach, describe, expect, it } from 'vitest'
import { githubTrigger } from '../src/channels/github.ts'
import { UserError } from '../src/shared/errors.ts'
import {
  INLINE_BYTE_LIMIT,
  INLINE_LIMIT,
  inlineOrSpill,
  linkedSpillIds,
  readObject,
} from '../src/memory/recall.ts'
import type { Runtime } from '../src/runtime.ts'
import { Store } from '../src/store/sqlite.ts'
import { freshRuntime, shutdown, tempHome } from './fixtures.ts'

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

describe('spill and read_object', () => {
  it('stores a long body and inlines only the summary plus id', () => {
    const store = new Store(tempHome())
    const body = `CI failed on auth test. ${'x'.repeat(400)}`
    const recall = inlineOrSpill(body, text => store.putSpill(text))
    expect(recall.spillId).toBeTruthy()
    expect(recall.inline.length).toBeLessThan(body.length)
    expect(recall.inline).toContain(`spillId=${recall.spillId}`)
    expect(store.getSpill(recall.spillId!)).toBe(body)
    store.close()
  })

  it('keeps the exact inline budget and spills wide characters or a blank summary', () => {
    let puts = 0
    const exact = 'a'.repeat(INLINE_LIMIT)
    const kept = inlineOrSpill(exact, () => { puts += 1; return 'spill_x' })
    expect(puts).toBe(0)
    expect(kept).toEqual({ inline: exact, bytes: INLINE_LIMIT })

    const blank = inlineOrSpill(' '.repeat(INLINE_LIMIT + 5), () => 'spill_blank')
    expect(blank.inline).toBe('(blank)… spillId=spill_blank')
    expect(blank.spillId).toBe('spill_blank')

    const wide = '测'.repeat(150)
    expect(wide.length).toBeLessThanOrEqual(INLINE_LIMIT)
    expect(Buffer.byteLength(wide)).toBeGreaterThan(INLINE_BYTE_LIMIT)
    const spilled = inlineOrSpill(wide, () => 'spill_wide')
    expect(spilled.spillId).toBe('spill_wide')
    expect(spilled.inline).toContain('spillId=spill_wide')
    expect(spilled.bytes).toBe(Buffer.byteLength(wide))
  })

  it('pages read_object, clamps a bad offset, and names neighbor spills', () => {
    const body = `abcdef spillId=spill_2 ${'测'.repeat(20)}`
    const first = readObject({ id: 'spill_1', body, limit: 6, neighbors: ['spill_1', 'spill_9', ''] })
    expect(first.offset).toBe(0)
    expect(first.text).toBe('abcdef')
    expect(first.truncated).toBe(true)
    expect(first.nextOffset).toBe(6)
    expect(first.neighbors).toEqual(['spill_9'])
    const second = readObject({ id: 'spill_1', body, offset: first.nextOffset, limit: 6 })
    expect(second.text).toBe(' spill')
    const rest = readObject({ id: 'spill_1', body, offset: body.length + 10, limit: 4 })
    expect(rest.text).toBe('')
    expect(rest.truncated).toBe(false)
    expect(rest.nextOffset).toBeUndefined()
    const negative = readObject({ id: 'spill_1', body, offset: -8, limit: 0 })
    expect(negative.offset).toBe(0)
    expect(negative.text.length).toBeGreaterThan(0)

    const pages = [first.text]
    let offset = first.nextOffset
    while (offset != null) {
      const page = readObject({ id: 'spill_1', body, offset, limit: 6 })
      pages.push(page.text)
      offset = page.nextOffset
    }
    expect(pages.join('')).toBe(body)

    expect(linkedSpillIds([
      { spillId: 'spill_1', inputs: [{ spillId: 'spill_9' }, { spillId: 'spill_1' }] },
      { spillId: 'spill_other' },
    ], 'spill_1', 'see spillId=spill_4')).toEqual(['spill_9', 'spill_4'])

    expect(() => readObject({ id: '  ', body: 'x' })).toThrow(UserError)
    expect(() => readObject({ id: 'spill_missing', body: undefined })).toThrow(/unknown spill spill_missing/)
  })

  it('makes the worker recall the spill with read_object', async () => {
    runtime = freshRuntime()
    const text = `CI failed on auth test. expected 200 got 500 at login. ${'frame at auth/session.ts '.repeat(12)}`
    expect(text.length).toBeGreaterThan(180)
    runtime.ingest(githubTrigger({ id: 'trg_pr42', pr: 42, text }))
    await runtime.jobsSettled()
    const logged = runtime.log.text()
    const spillId = /spillId=(spill_\d+)/.exec(logged)?.[1]
    expect(spillId).toBeTruthy()
    expect(runtime.store.getSpill(spillId!)).toBe(text)
    expect(logged).toContain(`[memory] read_object id=${spillId}`)
    expect(logged).toContain('Inline/Spill')
  })
})

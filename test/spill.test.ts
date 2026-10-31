import { afterEach, describe, expect, it } from 'vitest'
import { githubTrigger } from '../src/channels/github.ts'
import { inlineOrSpill } from '../src/memory/recall.ts'
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

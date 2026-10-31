import { afterEach, describe, expect, it } from 'vitest'
import { githubTrigger } from '../src/channels/github.ts'
import type { Runtime } from '../src/runtime.ts'
import { freshRuntime, shutdown } from './fixtures.ts'

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

describe('long-term spill index', () => {
  it('remembers a spilled body and finds it by substring', async () => {
    runtime = freshRuntime()
    const text = `login trace CI failed on auth test. ${'frame '.repeat(80)}`
    expect(text.length).toBeGreaterThan(180)
    runtime.ingest(githubTrigger({ id: 'trg_pr42', pr: 42, text }))
    await runtime.jobsSettled()
    const hits = runtime.memory.search('login trace')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.ticketId).toMatch(/^ticket_/)
    expect(runtime.store.getSpill(hits[0]!.spillId)).toBe(text)
    expect(runtime.memory.search('missing-token')).toEqual([])
  })
})

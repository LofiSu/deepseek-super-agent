import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { demoModel, runDemo } from '../src/cli/demo.ts'
import { requireLiveModelFromEnv } from '../src/harness/model.ts'
import { resolveLiveApi } from '../src/harness/providers.ts'

function detectLive(): boolean {
  try {
    return resolveLiveApi() !== null
  } catch {
    return false
  }
}

const forceOffline = process.env.DS_AGENT_ALLOW_MOCK_FIXTURE === '1' || process.env.CI === 'true'
const hasLive = !forceOffline && detectLive()

describe.skipIf(!hasLive)('live model demo (real API)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-live-'))

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('resolves HttpOpenAI not MockModel', () => {
    const model = requireLiveModelFromEnv()
    expect(model.name).toBe('HttpOpenAI')
    expect(model.name).not.toBe('MockModel')
    expect(demoModel().model.name).toBe('HttpOpenAI')
  })

  it('completes a tiny chat/completions round-trip', async () => {
    const model = requireLiveModelFromEnv()
    const result = await model.complete({
      role: 'router',
      messages: [{ role: 'user', content: 'Reply with exactly the word PONG and nothing else.' }],
      tools: [],
    })
    expect((result.text || '').length).toBeGreaterThan(0)
  }, 60_000)

  it('runs pnpm-demo flow against the live model', async () => {
    await runDemo(home)
  }, 300_000)
})

describe('live model gate (always)', () => {
  it('requireLiveModelFromEnv and demoModel refuse MockModel with empty env', () => {
    expect(() => requireLiveModelFromEnv({})).toThrow(/No live model configured; refusing MockModel/)
    expect(() => demoModel({})).toThrow(/MockModel is forbidden|requires a live model/)
  })
})

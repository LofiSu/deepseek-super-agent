import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bindRolePorts } from '../src/core/role-ports.ts'
import { ToolRegistry } from '../src/harness/tools.ts'
import { FeaturePrPublisher } from '../src/env/git-publish.ts'
import { parseRepo } from '../src/channels/github-source.ts'
import { UserError } from '../src/shared/errors.ts'
import type { Runtime } from '../src/runtime.ts'
import { LocalEnv } from '../src/env/local-env.ts'
import { freshRuntime, shutdown } from './fixtures.ts'

describe('publish_feature_pr tool', () => {
  let runtime: Runtime | undefined

  afterEach(async () => {
    if (runtime) await shutdown(runtime)
    runtime = undefined
  })

  it('is unavailable without publisher', async () => {
    runtime = freshRuntime({ allowMockModel: true })
    const tools = new ToolRegistry({
      store: runtime.store,
      ports: bindRolePorts(runtime.engine),
      env: new LocalEnv(path.join(runtime.home, 'workspaces')),
      metrics: runtime.metrics,
      redact: s => s,
      log: () => {},
      scheduleJob: () => {},
      routerTurn: async () => {},
    })
    await expect(
      tools.invoke(
        { id: 'c1', name: 'publish_feature_pr', args: { title: 't' } },
        { sessionId: 'w1', role: 'worker', ticketId: 'ticket-1' },
      ),
    ).rejects.toThrow(UserError)
  })

  it('is not exposed to router or watchdog', async () => {
    runtime = freshRuntime({ allowMockModel: true })
    const pub = new FeaturePrPublisher({
      repo: parseRepo('o/r'),
      workspace: workerId => path.join(runtime!.home, 'workspaces', workerId),
    })
    const tools = new ToolRegistry({
      store: runtime.store,
      ports: bindRolePorts(runtime.engine),
      env: new LocalEnv(path.join(runtime.home, 'workspaces')),
      metrics: runtime.metrics,
      redact: s => s,
      log: () => {},
      scheduleJob: () => {},
      routerTurn: async () => {},
      publishFeaturePr: pub,
    })
    expect((await tools.specsFor('router')).some(s => s.name === 'publish_feature_pr')).toBe(false)
    expect((await tools.specsFor('watchdog')).some(s => s.name === 'publish_feature_pr')).toBe(false)
    expect((await tools.specsFor('worker')).some(s => s.name === 'publish_feature_pr')).toBe(true)
  })
})

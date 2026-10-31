import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MockModel, requireLiveModelFromEnv, type Model } from '../src/harness/model.ts'
import { Runtime, type RuntimeOptions } from '../src/runtime.ts'

export function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-'))
}

function resolveFixtureModel(explicit?: Model): Model {
  if (explicit) {
    if (explicit.name === 'MockModel' && process.env.DS_AGENT_ALLOW_MOCK_FIXTURE !== '1') {
      throw new Error('freshRuntime refuses MockModel; configure DS_AGENT_API_* for a live model')
    }
    return explicit
  }
  // GitHub Actions offline gate only. Local default suite must use Magpie/live.
  if (process.env.DS_AGENT_ALLOW_MOCK_FIXTURE === '1') {
    return new MockModel()
  }
  return requireLiveModelFromEnv()
}

/**
 * Default: live Magpie/DeepSeek Runtime (MockModel forbidden).
 * Set DS_AGENT_ALLOW_MOCK_FIXTURE=1 only for offline CI without a live API.
 */
export function freshRuntime(opts: Partial<RuntimeOptions> = {}): Runtime {
  const { model: explicitModel, jobDelayMs, watchdogIntervalMs, stuckMs, home, ...rest } = opts
  const model = resolveFixtureModel(explicitModel)
  const live = model.name !== 'MockModel'
  return Runtime.create({
    home: home ?? tempHome(),
    model,
    jobDelayMs: jobDelayMs ?? (live ? 250 : 0),
    watchdogIntervalMs: watchdogIntervalMs ?? 60_000,
    stuckMs: stuckMs ?? 60_000,
    ...rest,
  })
}

export async function settleWithDeadline(runtime: Runtime, ms = 90_000): Promise<'settled' | 'deadline'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'deadline'>(resolve => {
    timer = setTimeout(() => resolve('deadline'), ms)
  })
  try {
    const result = await Promise.race([
      runtime.jobsSettled().then(() => 'settled' as const),
      deadline,
    ])
    return result
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function shutdown(runtime: Runtime): Promise<void> {
  if (!runtime.store.isOpen) return
  runtime.daemon.stop()
  await settleWithDeadline(runtime, 15_000).catch(() => undefined)
  if (runtime.store.isOpen) runtime.store.close()
}

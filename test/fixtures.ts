import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MockModel } from '../src/harness/model.ts'
import { Runtime, type RuntimeOptions } from '../src/runtime.ts'

export function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-'))
}

/** Tests pin MockModel so a developer API key cannot send them onto the network. */
export function freshRuntime(opts: Partial<RuntimeOptions> = {}): Runtime {
  return Runtime.create({
    home: tempHome(),
    model: new MockModel(),
    jobDelayMs: 0,
    watchdogIntervalMs: 60_000,
    stuckMs: 60_000,
    ...opts,
  })
}

export async function shutdown(runtime: Runtime): Promise<void> {
  if (!runtime.store.isOpen) return
  runtime.daemon.stop()
  await runtime.jobsSettled().catch(() => undefined)
  if (runtime.store.isOpen) runtime.store.close()
}

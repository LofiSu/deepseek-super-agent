import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Runtime, type RuntimeOptions } from '../src/runtime.ts'

export function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-'))
}

export function freshRuntime(opts: Partial<RuntimeOptions> = {}): Runtime {
  return Runtime.create({
    home: tempHome(),
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

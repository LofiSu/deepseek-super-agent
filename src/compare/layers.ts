import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MockModel } from '../harness/model.ts'
import { Runtime } from '../runtime.ts'
import type { SessionLayering, Ticket, Trigger } from '../shared/types.ts'

export interface LayerArm {
  name: SessionLayering
  routerSessions: number
  workerSessions: number
  tickets: number
  replies: number
  elapsedMs: number
}

export interface LayerComparison {
  dual: LayerArm
  single: LayerArm
  sameTicketCount: boolean
  note: string
}

const NOTE = 'Local MockModel harness. Not the published article eval.'

/** Run the same triggers through the dual-layer runtime and a single-session arm. */
export async function compareLayers(triggers: Trigger[]): Promise<LayerComparison> {
  const dual = await runArm('dual', triggers)
  const single = await runArm('single', triggers)
  return {
    dual,
    single,
    sameTicketCount: dual.tickets === single.tickets,
    note: NOTE,
  }
}

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-'))
}

async function closeRuntime(runtime: Runtime): Promise<void> {
  if (!runtime.store.isOpen) return
  runtime.daemon.stop()
  await runtime.jobsSettled().catch(() => undefined)
  if (runtime.store.isOpen) runtime.store.close()
}

async function runArm(layering: SessionLayering, triggers: Trigger[]): Promise<LayerArm> {
  const runtime = Runtime.create({
    home: tempHome(),
    model: new MockModel(),
    layering,
    jobDelayMs: 0,
    watchdogIntervalMs: 60_000,
    stuckMs: 60_000,
  })
  const started = performance.now()
  try {
    for (const trigger of triggers) runtime.ingest(trigger)
    await runtime.jobsSettled()
    return armFrom(runtime, layering, performance.now() - started)
  } finally {
    await closeRuntime(runtime)
  }
}

function armFrom(runtime: Runtime, name: SessionLayering, elapsed: number): LayerArm {
  const sessions = runtime.store.listSessions()
  return {
    name,
    routerSessions: sessions.filter(session => session.role === 'router').length,
    workerSessions: sessions.filter(session => session.role === 'worker').length,
    tickets: runtime.store.listDocs<Ticket>('ticket').length,
    replies: runtime.store.listReplies().length,
    elapsedMs: Math.round(elapsed * 100) / 100,
  }
}

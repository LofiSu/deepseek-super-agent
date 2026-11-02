import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { imTrigger } from '../channels/im.ts'
import { requireLiveModelFromEnv } from '../harness/model.ts'
import { compareBakeoff, type BakeoffSample } from '../metrics/bakeoff.ts'
import { Runtime } from '../runtime.ts'

const TEXT = '@ds-agent please fix the login timeout on checkout'
const DEADLINE_MS = Number(process.env.DS_AGENT_BAKEOFF_DEADLINE_MS) > 0
  ? Number(process.env.DS_AGENT_BAKEOFF_DEADLINE_MS)
  : 60_000

async function run(mode: 'dual' | 'single'): Promise<BakeoffSample> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `ds-agent-bakeoff-${mode}-`))
  const runtime = Runtime.create({
    home,
    model: requireLiveModelFromEnv(),
    singleSession: mode === 'single',
    jobDelayMs: 20,
    watchdogIntervalMs: 60_000,
  })
  const started = performance.now()
  runtime.ingest(imTrigger({
    id: `trg_${mode}`,
    thread: `topic/bakeoff-${mode}`,
    text: TEXT,
  }))
  let tickets = 0
  try {
    await Promise.race([
      runtime.jobsSettled(),
      new Promise(resolve => setTimeout(resolve, DEADLINE_MS)),
    ])
    tickets = runtime.store.listDocs('ticket').length
  } finally {
    runtime.daemon.stop()
    if (runtime.store.isOpen) runtime.store.close()
  }
  const snapshot = runtime.metrics.snapshot()
  fs.rmSync(home, { recursive: true, force: true })
  return {
    mode,
    modelCalls: snapshot.counters['model.call'],
    tickets,
    evalAccepts: snapshot.counters['eval.accept'],
    wallMs: Math.round(performance.now() - started),
    counters: { ...snapshot.counters },
  }
}

const dual = await run('dual')
const single = await run('single')
console.log(JSON.stringify(compareBakeoff(dual, single), null, 2))

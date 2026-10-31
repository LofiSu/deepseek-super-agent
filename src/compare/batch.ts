import { Engine } from '../core/engine.ts'
import type { Trigger } from '../shared/types.ts'
import { Store } from '../store/sqlite.ts'

export interface BatchPoint {
  mode: 'batched' | 'split'
  size: number
  decisions: number
  triggers: number
  elapsedMs: number
}

/**
 * Time one Eval drain.
 * `batched` parks every trigger on one thread, then drains once.
 * `split` uses a fresh thread per trigger, so the drain opens one decision each.
 */
export function measureBatchPoint(mode: BatchPoint['mode'], size: number, home: string): BatchPoint {
  if (size < 1) throw new Error('batch size must be at least 1')
  const store = new Store(home)
  const engine = new Engine({
    repo: store,
    now: () => new Date().toISOString(),
    log: () => undefined,
    scope: { admit: () => ({ listened: true, reason: 'bench' }) },
  })
  const started = performance.now()
  for (let i = 0; i < size; i += 1) {
    const thread = mode === 'batched' ? 'topic/bench' : `topic/bench-${i}`
    engine.receive(benchTrigger(`${mode}_${i}`, thread))
  }
  const decisions = engine.evaluateDue()
  const elapsedMs = Math.round((performance.now() - started) * 100) / 100
  const triggers = decisions.reduce((sum, decision) => sum + decision.triggerIds.length, 0)
  store.close()
  return { mode, size, decisions: decisions.length, triggers, elapsedMs }
}

function benchTrigger(id: string, thread: string): Trigger {
  return {
    id: `trg_${id}`,
    source: 'cli',
    threads: [{ source: 'cli', id: thread }],
    actor: { source: 'cli', id: 'bench' },
    human: true,
    addressed: 'direct',
    at: '2026-10-31T00:00:00.000Z',
    text: `please fix batch item ${id}`,
    channel: { source: 'cli', thread },
    meta: {},
  }
}

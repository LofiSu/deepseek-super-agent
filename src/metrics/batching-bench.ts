import { imTrigger } from '../channels/im.ts'
import { Engine } from '../core/engine.ts'
import type { Host } from '../core/host.ts'
import type { Decision } from '../shared/types.ts'
import { Store } from '../store/sqlite.ts'
import { summarizeCurve, type CurveSummary } from './curve.ts'
import { Metrics, type MetricsSnapshot } from './metrics.ts'

/**
 * T45: Router batching stress harness.
 *
 * Floods one Thread with Triggers before the Eval sequence point. In fold mode a
 * whole round becomes one Eval, so batch size grows with load while eval count stays
 * flat. The measured Eval latency is appended to the existing `curveSamples` curve.
 * Runtime defaults are untouched; this is a bench, not a code path Runtime selects.
 */

export const DEFAULT_STRESS_TRIGGERS_PER_ROUND = 64
export const DEFAULT_STRESS_ROUNDS = 4

export interface BatchingStressOptions {
  /** Same-Thread Triggers enqueued per round. Defaults to 64. */
  triggersPerRound?: number
  /** Loaded rounds reusing one Thread. Defaults to 4. */
  rounds?: number
  /** Thread id all rounds share. Defaults to `stress/batching`. */
  thread?: string
  /**
   * `true` (default) evaluates once per round, after the flood, and folds it.
   * `false` evaluates after every Trigger, the unbatched baseline.
   */
  fold?: boolean
}

export interface BatchingStressResult {
  submitted: number
  rounds: number
  /** Trigger ids assessed by each Eval, one entry per Eval. */
  batchSizes: number[]
  evalCount: number
  maxBatchSize: number
  /** submitted / evalCount. Larger means more folding. */
  foldRatio: number
  latency: CurveSummary
  metrics: MetricsSnapshot
}

/**
 * Runs the stress load against a real Store and Metrics in `home`.
 * The store is closed before returning; the caller owns the directory.
 */
export function runBatchingStress(
  home: string,
  options: BatchingStressOptions = {},
): BatchingStressResult {
  const triggersPerRound = positiveInt(options.triggersPerRound, DEFAULT_STRESS_TRIGGERS_PER_ROUND)
  const rounds = positiveInt(options.rounds, DEFAULT_STRESS_ROUNDS)
  const thread = options.thread ?? 'stress/batching'
  const fold = options.fold ?? true

  const store = new Store(home)
  const metrics = new Metrics(home)
  let tick = 0
  const now = () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1000).toISOString()
  const host: Host = {
    repo: store,
    now,
    metrics,
    log: () => undefined,
    scope: {
      // Mirror Runtime.ingest's admission counter without running the model filter.
      admit: () => {
        metrics.increment('ingress.admit')
        return { listened: true, reason: 'stress' }
      },
    },
  }
  const engine = new Engine(host)
  const batchSizes: number[] = []
  let submitted = 0

  try {
    for (let round = 0; round < rounds; round++) {
      for (let index = 0; index < triggersPerRound; index++) {
        const id = `trg_stress_${round}_${index}`
        // human:false keeps same-Thread follow-ups on the Eval queue instead of
        // the subscription bypass, so each round measures batching, not fan-out.
        engine.receive({
          ...imTrigger({ id, thread, text: `@ds-agent stress request ${id}`, at: now() }),
          human: false,
        })
        submitted += 1
        if (!fold) batchSizes.push(evaluateOnce(engine, metrics))
      }
      if (fold) batchSizes.push(evaluateOnce(engine, metrics))
    }
    const snapshot = metrics.snapshot()
    return {
      submitted,
      rounds,
      batchSizes,
      evalCount: batchSizes.length,
      maxBatchSize: batchSizes.reduce((max, size) => Math.max(max, size), 0),
      foldRatio: batchSizes.length === 0 ? 0 : submitted / batchSizes.length,
      latency: summarizeCurve(snapshot),
      metrics: snapshot,
    }
  } finally {
    if (store.isOpen) store.close()
  }
}

function evaluateOnce(engine: Engine, metrics: Metrics): number {
  const started = performance.now()
  const decisions: Decision[] = engine.evaluateDue()
  // Same unit the harness records: one model-latency sample per Eval.
  metrics.observeModelLatency(performance.now() - started)
  return decisions.reduce((size, decision) => size + decision.triggerIds.length, 0)
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback
}

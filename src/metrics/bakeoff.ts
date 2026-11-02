/** T45 bake-off: the same workload through the dual-layer and single-session paths. */

export interface BakeoffSample {
  mode: 'dual' | 'single'
  modelCalls: number
  tickets: number
  evalAccepts: number
  wallMs: number
  counters: Record<string, number>
}

export interface BakeoffComparison {
  dual: BakeoffSample
  single: BakeoffSample
  /** Router turns the single-session baseline did not pay for. */
  extraModelCalls: number
  /** tickets per model call; higher is cheaper. */
  ticketsPerCall: { dual: number; single: number }
  wallRatio: number
  verdict: string
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return numerator > 0 ? Number.POSITIVE_INFINITY : 0
  return numerator / denominator
}

export function compareBakeoff(dual: BakeoffSample, single: BakeoffSample): BakeoffComparison {
  const extraModelCalls = dual.modelCalls - single.modelCalls
  const comparison: BakeoffComparison = {
    dual,
    single,
    extraModelCalls,
    ticketsPerCall: {
      dual: ratio(dual.tickets, dual.modelCalls),
      single: ratio(single.tickets, single.modelCalls),
    },
    wallRatio: ratio(dual.wallMs, single.wallMs),
    verdict: '',
  }
  comparison.verdict = extraModelCalls > 0
    ? `dual paid ${extraModelCalls} extra model call(s) for Router sequencing`
    : extraModelCalls < 0
      ? `single-session paid ${-extraModelCalls} extra model call(s)`
      : 'both paths made the same number of model calls'
  return comparison
}

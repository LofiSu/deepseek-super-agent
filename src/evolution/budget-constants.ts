/**
 * Eval-call units the final-test path reserves out of `reserveEvals`.
 *
 * Lives outside budget-ledger.ts so budget validation can enforce the same
 * number without importing the ledger (which imports experiment.ts, which
 * imports budget validation).
 */
export const EVAL_CALLS_FINALTEST = 2
export const EVAL_CALLS_BASELINE_SEARCH = 2

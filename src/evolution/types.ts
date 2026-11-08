/** v1 evolves DeliverGate strategy JSON only — not arbitrary self-code patch of the repo. */

export const EVOLUTION_SCHEMA_VERSION = 1 as const
export const DELIVER_GATE_DOMAIN = 'deliver-gate-v1' as const

/** Allowlisted tunables for HeuristicDeliverGate-style scoring (JSON consumer at promotion). */
export interface DeliverGateStrategyV1 {
  schemaVersion: typeof EVOLUTION_SCHEMA_VERSION
  domain: typeof DELIVER_GATE_DOMAIN
  negativePattern: string
  positivePattern: string
  /** When true, any clause matching negativePattern vetoes unless an earlier clause was positive. */
  clauseLocalPositive: boolean
}

export interface EvolutionSplitManifest {
  schemaVersion: number
  domain: string
  splits: { train: string; validation: string; holdout: string }
  seed: number
}

export interface EvolutionEvalCase {
  id: string
  speculative: boolean
  report: { kind: string; text: string; deliver?: boolean }
  /**
   * Label used only inside the offline dataset file for scoring and for
   * train-failure-driven proposal; never passed to the gate under test.
   */
  expected: 'deliver' | 'discard'
}

export interface EvolutionSplitFile {
  cases: EvolutionEvalCase[]
}

export interface SplitScore {
  split: 'train' | 'validation' | 'holdout' | 'baseline'
  correct: number
  total: number
  accuracy: number
}

export type CandidateStatus =
  | 'evaluated'
  | 'rejected_malformed'
  | 'rejected_budget'
  | 'rejected_holdout_cheat'
  | 'rejected_regression'
  | 'rejected_timeout'
  | 'rejected_eval_error'

export interface EvolutionCandidateRecord {
  candidateId: string
  parentId: string | null
  lineageHash: string
  strategy: DeliverGateStrategyV1
  strategyDigest: string
  status: CandidateStatus
  scores: SplitScore[]
  proposedFrom: 'baseline' | 'train_failures'
  rejectionReason?: string
  createdAt: string
}

export interface EvolutionRunReport {
  schemaVersion: number
  domain: string
  runId: string
  datasetDigest: string
  evaluatorDigest: string
  seed: number
  archiveDir: string
  baseline: SplitScore[]
  candidates: EvolutionCandidateRecord[]
  budget: { maxCandidates: number; maxEvals: number; evalTimeoutMs: number }
  promotion?: { approvedAt: string; strategyDigest: string; artifactPath: string }
  rollback?: { rolledBackAt: string; previousDigest: string | null }
}

export interface EvolutionBudget {
  maxCandidates: number
  maxEvals: number
  evalTimeoutMs: number
}

export const DEFAULT_EVOLUTION_BUDGET: EvolutionBudget = {
  maxCandidates: 8,
  maxEvals: 64,
  evalTimeoutMs: 30_000,
}

export interface CandidateProposer {
  propose(input: {
    baseline: DeliverGateStrategyV1
    trainFailures: EvolutionEvalCase[]
    seed: number
    index: number
  }): DeliverGateStrategyV1 | null
}

/** v2 evolves DeliverGate token lists only — not arbitrary regex or repo self-code. */

export const EVOLUTION_SCHEMA_VERSION = 2 as const
export const DELIVER_GATE_DOMAIN = 'deliver-gate-v1' as const

export interface DeliverGateStrategyV1 {
  schemaVersion: 1 | 2
  domain: typeof DELIVER_GATE_DOMAIN
  /** v2 primary */
  positiveTokens?: string[]
  negativeTokens?: string[]
  /** legacy v1 — accepted only when passing safe-pattern audit at parse */
  negativePattern?: string
  positivePattern?: string
  clauseLocalPositive: boolean
}

export interface EvolutionSplitManifest {
  schemaVersion: number
  domain: string
  splits: { train: string; validation: string; finaltest: string }
  splitDigests: { train?: string; validation?: string; finaltest: string }
  seed: number
}

export interface EvolutionEvalCase {
  id: string
  speculative: boolean
  report: { kind: string; text: string; deliver?: boolean }
  expected: 'deliver' | 'discard'
}

export interface EvolutionSplitFile {
  cases: EvolutionEvalCase[]
}

export type SearchSplit = 'train' | 'validation'
export type AllSplit = SearchSplit | 'finaltest' | 'baseline'

export interface SplitScore {
  split: AllSplit
  correct: number
  total: number
  accuracy: number
}

export type CandidateStatus =
  | 'evaluated'
  | 'rejected_malformed'
  | 'rejected_budget'
  | 'rejected_duplicate'
  | 'rejected_regression'
  | 'rejected_timeout'
  | 'rejected_eval_error'
  | 'skipped_invalid'

export interface EvolutionCandidateRecord {
  candidateId: string
  parentId: string | null
  directionKey: string
  lineageHash: string
  strategy: DeliverGateStrategyV1
  strategyDigest: string
  artifactDigest: string
  status: CandidateStatus
  /** search-phase scores only (train+validation) */
  scores: SplitScore[]
  reward: 'success' | 'failure' | 'skip'
  proposedFrom: 'baseline' | 'train_failures' | 'policy_memory'
  /** Train arm that motivated this candidate (search only). */
  failureCaseId?: string
  selectionReason?: string
  rejectionReason?: string
  round: number
  createdAt: string
}

export interface BudgetReservation {
  units: number
  reason: string
  at: string
  consumed: boolean
}

export interface BudgetLedger {
  maxCandidates: number
  maxEvals: number
  evalTimeoutMs: number
  maxOutputBytes: number
  reserveEvals: number
  usedEvals: number
  errors: number
  timeouts: number
  providerCalls: number
  reservations?: BudgetReservation[]
  finaltestReserved?: boolean
  baselineSearchReserved?: boolean
  totalWallDeadlineMs?: number
  wallStartedAt?: string
}

export interface EvolutionRunReport {
  schemaVersion: number
  domain: string
  runId: string
  experimentId: string
  round: number
  datasetDigest: string
  evaluatorDigest: string
  seed: number
  archiveDir: string
  baseline: SplitScore[]
  candidates: EvolutionCandidateRecord[]
  budget: BudgetLedger
  selector: 'kl-ucb' | 'policy-memory' | 'simplified-greedy'
}

export interface ExperimentFinalTestRecord {
  ledgerId: string
  openedAt: string
  closedAt: string
  scores: SplitScore[]
  candidateId: string
  strategyDigest: string
  datasetDigest: string
  evaluatorDigest: string
}

export type ExperimentPhase = 'search' | 'frozen' | 'finalized'

export interface FrozenSelection {
  candidateId: string
  artifactDigest: string
  strategyDigest: string
  runId: string
  artifactPath: string
  frozenAt: string
}

export type FinalTestClaimState = 'CLAIMED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'

export interface FinalTestClaim {
  claimId: string
  state: FinalTestClaimState
  openedAt: string
  closedAt?: string
  candidateId: string
  strategyDigest: string
}

export interface KlArmSnapshot {
  id: string
  observations: { id: string; reward: 0 | 1; skip?: boolean }[]
}

export interface ExperimentState {
  experimentId: string
  phase: ExperimentPhase
  datasetDigest: string
  evaluatorDigest: string
  seed: number
  selectedCandidateId: string | null
  frozenSelection: FrozenSelection | null
  frozenAt: string | null
  finalizedAt: string | null
  finalTest: ExperimentFinalTestRecord | null
  finalTestClaim: FinalTestClaim | null
  budget: BudgetLedger
  seenDirections: string[]
  totalCandidatesGenerated: number
  totalOpportunities: number
  klArms: KlArmSnapshot[]
  frozenRunReceipt: EvolutionRunReport | null
}

export interface EvolutionBudget {
  maxCandidates: number
  maxEvals: number
  evalTimeoutMs: number
  maxOutputBytes?: number
  reserveEvals?: number
  /** Cap candidates evaluated in this run only (experiment cumulative unchanged). */
  maxCandidatesThisRun?: number
}

export const DEFAULT_EVOLUTION_BUDGET: EvolutionBudget = {
  maxCandidates: 8,
  maxEvals: 64,
  evalTimeoutMs: 30_000,
  maxOutputBytes: 65_536,
  reserveEvals: 8,
}

export interface PolicyLesson {
  id: string
  appliesWhen: string
  mechanismHypothesis: string
  recommendedChange: string
  /** Token to try on train miss (structured; no fixture literals). */
  preferredToken?: string
  targets: string[]
  sources: string[]
  status: 'active' | 'retired'
  directionKey?: string
  successfulPattern?: string
  failurePattern?: string
}

export interface PolicyMemoryCarrier {
  schemaVersion: 1
  experimentId: string
  round: number
  maxChars: number
  lessons: PolicyLesson[]
  snapshot: string
}

export interface CandidateProposer {
  propose(input: {
    baseline: DeliverGateStrategyV1
    parentStrategy: DeliverGateStrategyV1
    trainFailures: EvolutionEvalCase[]
    memory: PolicyMemoryCarrier
    seed: number
    failureCaseId: string
    seenDirections: Set<string>
    useMemory?: boolean
  }): DeliverGateStrategyV1 | null
}

export interface PromotionRecord {
  approvedAt: string
  strategyDigest: string
  artifactDigest: string
  datasetDigest: string
  evaluatorDigest: string
  artifactPath: string
  runId: string
  candidateId: string
  experimentId: string
  finalTestLedgerId: string
}

import path from 'node:path'
import type { LoadedEvolutionDataset } from './dataset.ts'
import { loadEvolutionDataset } from './dataset.ts'
import { loadExperiment, openFinalTestLedger, recordFinalTest } from './experiment.ts'
import { computeEvaluatorDigest } from './evaluator-identity.ts'
import { readJsonFile } from './io.ts'
import { evolutionArchiveRoot } from './archive.ts'
import type { EvolutionCandidateRecord } from './types.ts'
import { parseDeliverGateStrategy } from './strategy-gate.ts'
import { scoreCases } from './score.ts'
import { stableJsonDigest } from './digest.ts'

export function loadCandidateArtifact(home: string, candidateId: string): EvolutionCandidateRecord {
  const file = path.join(evolutionArchiveRoot(home), candidateId, 'candidate.json')
  return readJsonFile<EvolutionCandidateRecord>(file)
}

/** One-shot sealed split C evaluation; never re-used for search gates. */
export function runFinalTestOnce(input: {
  home: string
  datasetRoot: string
  candidateId: string
}): { scores: ReturnType<typeof scoreCases>[]; ledgerId: string } {
  const experiment = loadExperiment(input.home)
  if (!experiment) throw new Error('missing experiment')
  if (experiment.phase === 'finalized') throw new Error('final test already finalized')
  if (experiment.finalTest !== null) throw new Error('duplicate final test open rejected')
  if (experiment.selectedCandidateId !== input.candidateId) {
    throw new Error('candidate not frozen selection')
  }
  const evaluatorDigest = computeEvaluatorDigest()
  if (evaluatorDigest !== experiment.evaluatorDigest) {
    throw new Error('evaluator digest drift; refuse final test')
  }
  const dataset: LoadedEvolutionDataset = loadEvolutionDataset(input.datasetRoot)
  if (dataset.datasetDigest !== experiment.datasetDigest) {
    throw new Error('dataset digest mismatch')
  }
  const artifact = loadCandidateArtifact(input.home, input.candidateId)
  const strategy = parseDeliverGateStrategy(artifact.strategy)
  const strategyDigest = stableJsonDigest(strategy)
  if (strategyDigest !== artifact.strategyDigest) {
    throw new Error('artifact strategy digest mismatch')
  }

  const ledger = openFinalTestLedger(input.candidateId, {
    strategyDigest,
    datasetDigest: dataset.datasetDigest,
    evaluatorDigest,
  })
  const score = scoreCases(strategy, 'finaltest', dataset.finaltest)
  ledger.scores = [score]
  ledger.closedAt = new Date().toISOString()
  recordFinalTest(input.home, ledger)
  return { scores: [score], ledgerId: ledger.ledgerId }
}

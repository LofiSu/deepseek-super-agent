#!/usr/bin/env node
import { runFinalTestOnce } from '../src/evolution/finalize.ts'

const home = process.argv[2]
const datasetRoot = process.argv[3]
const candidateId = process.argv[4]
if (!home || !datasetRoot || !candidateId) {
  console.error('usage: finalize-once.ts <home> <datasetRoot> <candidateId>')
  process.exit(2)
}

runFinalTestOnce({ home, datasetRoot, candidateId })
  .then(out => {
    console.log(JSON.stringify({ ok: true, ...out }))
  })
  .catch(error => {
    console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    process.exit(1)
  })

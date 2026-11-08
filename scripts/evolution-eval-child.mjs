#!/usr/bin/env node
/**
 * Trusted evaluator entrypoint for an isolated OS child (no network intent).
 * Reads frozen inputs from disk paths on argv; prints one JSON line to stdout.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  const strategyPath = process.argv[2]
  const splitPath = process.argv[3]
  const splitName = process.argv[4]
  if (!strategyPath || !splitPath || !splitName) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'usage: strategy.json split.json splitName' }) + '\n')
    process.exit(2)
  }
  const resolvedStrategy = fs.realpathSync(strategyPath)
  const resolvedSplit = fs.realpathSync(splitPath)
  const strategy = JSON.parse(fs.readFileSync(resolvedStrategy, 'utf8'))
  const split = JSON.parse(fs.readFileSync(resolvedSplit, 'utf8'))

  const scoreMod = await import(pathToFileURL(path.join(repoRoot, 'src/evolution/score.ts')).href)
  const gateMod = await import(pathToFileURL(path.join(repoRoot, 'src/evolution/strategy-gate.ts')).href)
  const parsed = gateMod.parseDeliverGateStrategy(strategy)
  const score = scoreMod.scoreCases(parsed, splitName, split.cases)
  process.stdout.write(JSON.stringify({ ok: true, score }) + '\n')
  process.exit(0)
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n')
  process.exit(1)
})

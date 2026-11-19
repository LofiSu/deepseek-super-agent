#!/usr/bin/env node
/**
 * Test-only stand-in for the evaluator child: records its own pid and a tick
 * counter to a file every 100ms, then exits after 15s. The isolate-eval
 * timeout regression uses it to prove that a SIGKILLed parent either does or
 * does not leave this worker running.
 */
import fs from 'node:fs'

const statePath = process.argv[2]
if (!statePath) {
  process.stderr.write('usage: evolution-eval-hang-worker.mjs <state.json>\n')
  process.exit(2)
}

const startedAt = Date.now()
let ticks = 0

function writeState() {
  fs.writeFileSync(
    statePath,
    JSON.stringify({ pid: process.pid, ticks, elapsed: Date.now() - startedAt }),
    'utf8',
  )
}

writeState()
const timer = setInterval(() => {
  ticks += 1
  writeState()
}, 100)

setTimeout(() => {
  clearInterval(timer)
  process.exit(0)
}, 15_000)

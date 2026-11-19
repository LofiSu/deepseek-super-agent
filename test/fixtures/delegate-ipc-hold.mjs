/**
 * Stays alive during long specialist work; stdin can optionally finish it.
 */
import fs from 'node:fs'
import process from 'node:process'

// Test supervisor uses this opt-in file to attest the exact detached child PID.
const testPidFile = process.env.DS_AGENT_TEST_DELEGATE_PID_FILE
if (testPidFile) fs.writeFileSync(testPidFile, `${process.pid}\n`, { flag: 'wx' })

// Ignored or closed stdin is not an event-loop handle; keep the delegate alive.
setInterval(() => {}, 1 << 30)

process.stdin.setEncoding('utf8')
process.stdin.on('data', () => {
  process.stdout.write(JSON.stringify({ done: true, args: process.argv.slice(2) }))
  process.exit(0)
})

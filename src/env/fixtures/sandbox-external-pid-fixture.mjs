/**
 * Owned external process for sandbox process-isolation probe (not destructive).
 * Writes JSON { pid } to argv[1] then sleeps until SIGTERM.
 */
import fs from 'node:fs'

const out = process.argv[2]
if (!out) {
  console.error('usage: fixture.mjs <port-or-path-file>')
  process.exit(2)
}
fs.writeFileSync(out, JSON.stringify({ pid: process.pid, ppid: process.ppid }))
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 60_000)

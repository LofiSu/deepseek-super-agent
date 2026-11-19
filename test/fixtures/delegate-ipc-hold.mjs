/**
 * Stays alive during long specialist work; stdin can optionally finish it.
 */
import process from 'node:process'

// Ignored or closed stdin is not an event-loop handle; keep the delegate alive.
setInterval(() => {}, 1 << 30)

process.stdin.setEncoding('utf8')
process.stdin.on('data', () => {
  process.stdout.write(JSON.stringify({ done: true, args: process.argv.slice(2) }))
  process.exit(0)
})

/**
 * Blocks on stdin until a line is received (simulates long specialist work).
 */
import process from 'node:process'

process.stdin.setEncoding('utf8')
process.stdin.on('data', () => {
  process.stdout.write(JSON.stringify({ done: true, args: process.argv.slice(2) }))
  process.exit(0)
})


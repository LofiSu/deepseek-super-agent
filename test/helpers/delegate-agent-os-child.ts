/**
 * Immediate delegate specialist for OS-fault tests (task is argv, no shell).
 */
import process from 'node:process'

const task = process.argv[2] ?? ''
if (!task.trim()) process.exit(1)
process.stdout.write(JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  task,
}))
process.exit(0)


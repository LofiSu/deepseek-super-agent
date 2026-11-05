import process from 'node:process'

const mode = process.argv[2]
if (mode === 'slow') {
  setTimeout(() => process.exit(0), 10_000)
} else if (mode === 'noisy') {
  process.stdout.write('x'.repeat(10_000))
} else if (mode === 'env') {
  process.stdout.write(process.env.DS_AGENT_FIXTURE_TOKEN ?? 'missing')
} else {
  process.stdout.write(JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
  }))
}

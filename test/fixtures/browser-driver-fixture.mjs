// Test driver for ds-agent-browser-errand/v1. It never touches a real browser.
import process from 'node:process'
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const mode = process.argv[2] ?? 'echo'
let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { raw += chunk })
process.stdin.on('end', () => {
  if (mode === 'slow') {
    setTimeout(() => process.exit(0), 10_000)
    return
  }
  if (mode === 'exit') {
    process.stderr.write('driver failed on purpose\n')
    process.exit(7)
  }
  if (mode === 'badjson') {
    process.stdout.write('not json')
    return
  }
  let request
  try {
    request = JSON.parse(raw)
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: 'fixture got invalid JSON' }))
    return
  }
  if (mode === 'error') {
    process.stdout.write(JSON.stringify({ ok: false, error: 'driver exploded\nsecond line' }))
    return
  }
  if (mode === 'error-token') {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: `${'x'.repeat(295)}${process.env.DIAG_TOKEN ?? ''}`,
    }))
    return
  }
  if (mode === 'split-utf8') {
    const output = Buffer.from(JSON.stringify({
      ok: true,
      result: { url: 'https://example.com/page', text: '€' },
    }))
    const euro = output.indexOf(Buffer.from('€'))
    process.stdout.write(output.subarray(0, euro + 1))
    setTimeout(() => process.stdout.write(output.subarray(euro + 1, euro + 2)), 10)
    setTimeout(() => process.stdout.end(output.subarray(euro + 2)), 20)
    return
  }
  if (mode === 'oversized-utf8') {
    process.stdout.write(JSON.stringify({
      ok: true,
      result: { url: 'https://example.com/page', text: '€'.repeat(400_000) },
    }))
    return
  }
  if (mode === 'inherited-pipe') {
    const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5_000)'], {
      detached: true,
      stdio: 'inherit',
    })
    fs.writeFileSync(process.argv[3], String(helper.pid))
    process.stdout.write(JSON.stringify({ ok: true, result: { url: 'https://example.com/page' } }))
    return
  }
  if (mode === 'irreversible') {
    process.stdout.write(JSON.stringify({ ok: true, result: { performed: request.action } }))
    return
  }
  const base = {
    echo: request,
    url: request.url ?? 'https://example.com/page',
    title: 'Example Domain',
  }
  if (request.action === 'navigate') {
    process.stdout.write(JSON.stringify({ ok: true, result: base }))
  } else if (request.action === 'read') {
    process.stdout.write(JSON.stringify({
      ok: true,
      result: { ...base, text: 'r'.repeat(60) },
    }))
  } else if (request.action === 'fill') {
    process.stdout.write(JSON.stringify({
      ok: true,
      result: { ...base, filled: request.fields.length },
    }))
  } else if (request.action === 'extract') {
    process.stdout.write(JSON.stringify({
      ok: true,
      result: { ...base, items: ['one', 'two', 'three', 'four'] },
    }))
  } else {
    // A raw request that bypassed the adapter can reach here; report it so the
    // test can prove the driver itself also refuses irreversible actions.
    process.stdout.write(JSON.stringify({ ok: false, error: `unsupported action ${request.action}` }))
  }
})

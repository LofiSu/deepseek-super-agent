import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const helperUrl = new URL('./helpers/delegate-os-capability-probe.ts', import.meta.url).href
const suitePath = path.resolve('test/external-effects-os-fault.test.ts')
const vitestPath = path.resolve('node_modules/vitest/vitest.mjs')
const tempHomes: string[] = []

type WhichMode = 'absent' | 'present'

function controlledPath(which: WhichMode, home: string): string {
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin)
  if (which === 'present') {
    const executable = path.join(bin, 'which')
    fs.writeFileSync(executable, '#!/bin/sh\nexit 1\n')
    fs.chmodSync(executable, 0o700)
  }
  return bin
}

function emptyHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-os-import-'))
  tempHomes.push(home)
  return home
}

afterEach(() => {
  for (const home of tempHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe.each([
  { which: 'absent' as const, label: 'without which or Python 3' },
  { which: 'present' as const, label: 'with which but without Python 3' },
])('non-Linux capability import $label', ({ which }) => {
  it('imports the helper without spawning a process', () => {
    const home = emptyHome()
    const bin = controlledPath(which, home)
    const childCode = `
      import cp from 'node:child_process'
      import { syncBuiltinESMExports } from 'node:module'
      const counts = { execFile: 0, execFileSync: 0, spawn: 0, spawnSync: 0 }
      for (const name of Object.keys(counts)) {
        const original = cp[name]
        cp[name] = (...args) => { counts[name] += 1; return original(...args) }
      }
      syncBuiltinESMExports()
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      try {
        const helper = await import(${JSON.stringify(helperUrl)})
        let invocationError = ''
        try { await helper.runDelegateCapabilityProbe('missing_open') }
        catch (error) { invocationError = String(error) }
        console.log(JSON.stringify({ imported: true, platform: process.platform, invocationError, counts }))
      } catch (error) {
        console.log(JSON.stringify({ imported: false, platform: process.platform, error: String(error), counts }))
      }
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
      cwd: process.cwd(),
      env: { PATH: bin, HOME: home, TMPDIR: home, CI: 'true', NODE_NO_WARNINGS: '1' },
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    const observation = JSON.parse(result.stdout.trim()) as {
      imported: boolean
      platform: string
      invocationError: string
      counts: Record<string, number>
    }
    expect(observation.imported).toBe(true)
    expect(observation.platform).toBe('darwin')
    expect(observation.invocationError).toContain('delegate capability probes require Linux')
    expect(Object.values(observation.counts)).toEqual([0, 0, 0, 0])
  })

  it('collects and skips the real Linux-only suite without spawning a process', () => {
    const home = emptyHome()
    const bin = controlledPath(which, home)
    const setupPath = path.join(home, 'setup.mjs')
    const configPath = path.join(home, 'vitest.config.mjs')
    const reportPath = path.join(home, 'report.json')
    const callsPath = path.join(home, 'child-process-calls.json')
    fs.writeFileSync(setupPath, `
      import cp from 'node:child_process'
      import fs from 'node:fs'
      import { syncBuiltinESMExports } from 'node:module'
      const counts = { execFile: 0, execFileSync: 0, spawn: 0, spawnSync: 0 }
      const save = () => fs.writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(counts))
      save()
      for (const name of Object.keys(counts)) {
        const original = cp[name]
        cp[name] = (...args) => { counts[name] += 1; save(); return original(...args) }
      }
      syncBuiltinESMExports()
      Object.defineProperty(process, 'platform', { value: 'darwin' })
    `)
    fs.writeFileSync(configPath, `export default { test: {
      include: [${JSON.stringify(suitePath)}],
      setupFiles: [${JSON.stringify(setupPath)}],
      pool: 'threads',
      minWorkers: 1,
      maxWorkers: 1,
    } }\n`)
    const result = spawnSync(process.execPath, [
      vitestPath,
      'run',
      suitePath,
      '--config', configPath,
      '--reporter=json',
      `--outputFile=${reportPath}`,
    ], {
      cwd: process.cwd(),
      env: {
        PATH: bin,
        HOME: home,
        TMPDIR: home,
        CI: 'true',
        DS_AGENT_ALLOW_MOCK_FIXTURE: '1',
        NODE_NO_WARNINGS: '1',
      },
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    expect(result.error).toBeUndefined()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
      numTotalTests: number
      numPendingTests: number
      numFailedTests: number
    }
    expect(report.numTotalTests).toBe(21)
    expect(report.numPendingTests).toBe(21)
    expect(report.numFailedTests).toBe(0)
    const calls = JSON.parse(fs.readFileSync(callsPath, 'utf8')) as Record<string, number>
    expect(Object.values(calls)).toEqual([0, 0, 0, 0])
  })
})

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { evalChildArgs } from '../src/evolution/isolate-eval.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tsxCli = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs')
const childScript = path.join(repoRoot, 'scripts/evolution-eval-child.mjs')
const hangWorker = path.join(repoRoot, 'test/fixtures/evolution-eval-hang-worker.mjs')

interface WorkerState {
  pid: number
  ticks: number
  elapsed: number
}

const tempDirs: string[] = []
const spawned: ChildProcess[] = []
const workerPids = new Set<number>()

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function killQuietly(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 10_000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(25)
  }
}

function readState(statePath: string): WorkerState | undefined {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as WorkerState
  } catch {
    return undefined
  }
}

function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function tempStatePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-eval-timeout-'))
  tempDirs.push(dir)
  return path.join(dir, 'worker.json')
}

async function startWorker(argv: string[], statePath: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [...argv, statePath], {
    cwd: repoRoot,
    stdio: 'ignore',
  })
  spawned.push(child)
  const state = await waitFor(() => readState(statePath), 15_000, 'worker heartbeat')
  workerPids.add(state.pid)
  return child
}

afterEach(async () => {
  for (const pid of workerPids) killQuietly(pid)
  workerPids.clear()
  const children = spawned.splice(0)
  for (const child of children) killQuietly(child.pid)
  await Promise.all(children.map(child => waitForExit(child, 2_000)))
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('isolate-eval child spawn', () => {
  it('uses --import tsx so the evaluator is a direct child of the runtime', () => {
    expect(fs.existsSync(tsxCli)).toBe(true)
    const paths = { strategyPath: '/tmp/strategy.json', splitPath: '/tmp/split.json', splitName: 'train' }
    const argv = evalChildArgs(paths)
    expect(argv).toEqual(['--import', 'tsx', childScript, '/tmp/strategy.json', '/tmp/split.json', 'train'])
    expect(argv[0]).not.toBe(tsxCli)
    expect(argv[0]).not.toContain('tsx/dist/cli.mjs')
  })

  it('falls back to a plain node script when the tsx CLI is absent', () => {
    const paths = { strategyPath: '/tmp/strategy.json', splitPath: '/tmp/split.json', splitName: 'train' }
    expect(evalChildArgs(paths, false)).toEqual([
      childScript,
      '/tmp/strategy.json',
      '/tmp/split.json',
      'train',
    ])
  })

  it('SIGKILL of the tsx CLI wrapper leaves the evaluator grandchild running', async () => {
    expect(fs.existsSync(tsxCli)).toBe(true)
    const statePath = tempStatePath()
    const child = await startWorker([tsxCli, hangWorker], statePath)
    const before = readState(statePath)!
    // The wrapper is not the script: this is the orphan-producing indirection.
    expect(before.pid).not.toBe(child.pid)

    child.kill('SIGKILL')
    await waitForExit(child)

    // The grandchild survives the wrapper's death and keeps ticking.
    const later = await waitFor(
      () => {
        const state = readState(statePath)
        return state && state.ticks > before.ticks ? state : undefined
      },
      5_000,
      'heartbeat after killing the tsx CLI',
    )
    expect(later.pid).toBe(before.pid)
    expect(isAlive(before.pid)).toBe(true)
  })

  it('SIGKILL of a direct --import tsx child stops the evaluator', async () => {
    const statePath = tempStatePath()
    const child = await startWorker(['--import', 'tsx', hangWorker], statePath)
    const before = readState(statePath)!
    // No wrapper: the process we spawned is the evaluator.
    expect(child.pid).toBe(before.pid)

    child.kill('SIGKILL')
    await waitForExit(child)
    await waitFor(() => (isAlive(before.pid) ? undefined : true), 5_000, 'evaluator exit')

    const ticksAtExit = readState(statePath)!.ticks
    await sleep(500)
    expect(readState(statePath)!.ticks).toBe(ticksAtExit)
    expect(isAlive(before.pid)).toBe(false)
  })
})

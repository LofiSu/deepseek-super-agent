import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { UserError } from '../shared/errors.ts'

/** Offline unit suite aligned with `pnpm test:coverage` exclusions. */
export const OFFLINE_VITEST_EXCLUDE = [
  'test/live-demo.test.ts',
  'test/live-e2e.test.ts',
  'test/team-live.test.ts',
  'test/demos-real-channels.test.ts',
] as const

const GIT_LOCAL_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } as const

function runHostCommand(args: string[], cwd: string): { ok: boolean; output: string } {
  const r = spawnSync('pnpm', args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().slice(0, 12_000)
  return { ok: r.status === 0, output }
}

function ensureNodeModules(workspace: string): void {
  const nm = path.join(workspace, 'node_modules')
  if (fs.existsSync(nm)) return
  const install = spawnSync('pnpm', ['install', '--frozen-lockfile'], {
    cwd: workspace,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (install.status !== 0) {
    throw new UserError(
      `implementer: pnpm install failed: ${(install.stderr ?? '').trim().slice(0, 400)}`,
    )
  }
}

function listTestFilesAtRef(workspace: string, ref: string): Set<string> {
  const r = spawnSync('git', ['ls-tree', '-r', '--name-only', ref, '--', 'test/'], {
    cwd: workspace,
    encoding: 'utf8',
    env: GIT_LOCAL_ENV,
  })
  if (r.status !== 0) {
    throw new UserError(`implementer: could not list tests at ${ref}`)
  }
  const files = new Set<string>()
  for (const line of (r.stdout ?? '').split(/\r?\n/)) {
    const p = line.trim()
    if (p.endsWith('.test.ts') || p.endsWith('.test.tsx')) files.add(p)
  }
  return files
}

export function assertNoDeletedBaselineTests(workspace: string, baseHead: string): void {
  const atBase = listTestFilesAtRef(workspace, baseHead)
  for (const rel of atBase) {
    const abs = path.join(workspace, rel)
    if (!fs.existsSync(abs)) {
      throw new UserError(`implementer: refused publish — test file removed: ${rel}`)
    }
  }
}

export function runImplementerHoldout(workspace: string, label: string): void {
  ensureNodeModules(workspace)
  const typecheck = runHostCommand(['typecheck'], workspace)
  const vitestArgs = [
    'exec',
    'vitest',
    'run',
    ...OFFLINE_VITEST_EXCLUDE.flatMap(f => ['--exclude', f]),
  ]
  const tests = runHostCommand(vitestArgs, workspace)
  if (!typecheck.ok || !tests.ok) {
    throw new UserError(
      `implementer: holdout failed ${label}: typecheck=${typecheck.ok} tests=${tests.ok}\n`
      + `${typecheck.output}\n${tests.output}`,
    )
  }
}

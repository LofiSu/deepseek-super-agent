import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserError } from '../shared/errors.ts'
import { readIsolationFromEnv, wrapBashCommand, type SandboxPolicy, type SandboxSystem } from './seccomp.ts'

/** Diagnostic only: wrapper on PATH and argv shape. Never implies kernel enforcement. */
export interface SandboxWrapperProbe {
  platform: string
  wrapper: 'sandbox-exec' | 'bwrap' | null
  /** False when sandbox is enabled but no wrapper exists — fail closed at bash time. */
  canWrap: boolean
}

export type SandboxConfinementOutcome =
  | 'enforced'
  | 'not_enforced'
  | 'unsupported'
  | 'probe_failed'

export type SandboxDimensionStatus =
  | SandboxConfinementOutcome
  | 'not_tested'

/** Per-dimension confinement signals. Only `write` may reach `enforced` / `not_enforced` today. */
export interface SandboxConfinementDimensions {
  write: SandboxDimensionStatus
  read: SandboxDimensionStatus
  network: SandboxDimensionStatus
  process: SandboxDimensionStatus
}

export type SandboxRequiredDimension = 'write' | 'read' | 'network' | 'process'

const REQUIRED_DIMENSIONS = new Set<SandboxRequiredDimension>(['write', 'read', 'network', 'process'])

/** Injectable runner for unit tests (fake wrappers, forced failures). */
export interface SandboxConfinementProbeHooks {
  runWrapped?: (command: string, policy: SandboxPolicy, system: SandboxSystem) => SpawnSyncReturns<string>
  runUnsandboxed?: (command: string) => SpawnSyncReturns<string>
  /** When set, skips spawning the external loopback fixture. */
  loopbackPort?: number
}

/** Host execution probe: positive exec/write + negative write outside writable root. */
export interface SandboxConfinementProbe {
  platform: string
  wrapper: SandboxWrapperProbe['wrapper']
  /** Aggregate write-confinement only (not read/network/process). */
  outcome: SandboxConfinementOutcome
  /** Wrapped `true` exited 0. */
  positiveExecOk: boolean
  /** Wrapped write inside writable root succeeded. Null when probe did not run. */
  positiveWriteOk: boolean | null
  /** Wrapped write outside writable root was blocked (exit 0 with no file). Null when unsupported. */
  negativeWriteBlocked: boolean | null
  /** Unsandboxed same-user write to forbidden sibling succeeded (control). */
  unconfinedForbiddenWriteOk: boolean | null
  dimensions: SandboxConfinementDimensions
  detail?: string
}

const EXIT_WRITE_SUCCEEDED_OUTSIDE = 12

export function probeSandboxWrapper(system: SandboxSystem = defaultSystem()): SandboxWrapperProbe {
  const policy = baseProbePolicy()
  try {
    if (system.platform === 'darwin') {
      if (!system.available('sandbox-exec')) return { platform: system.platform, wrapper: null, canWrap: false }
      wrapBashCommand('true', policy, system)
      return { platform: system.platform, wrapper: 'sandbox-exec', canWrap: true }
    }
    if (system.platform === 'linux') {
      if (!system.available('bwrap')) return { platform: system.platform, wrapper: null, canWrap: false }
      wrapBashCommand('true', policy, system)
      return { platform: system.platform, wrapper: 'bwrap', canWrap: true }
    }
    return { platform: system.platform, wrapper: null, canWrap: false }
  } catch {
    return { platform: system.platform, wrapper: null, canWrap: false }
  }
}

function defaultSystem(): SandboxSystem {
  return {
    platform: process.platform,
    available: bin => spawnSync('which', [bin], { stdio: 'ignore' }).status === 0,
    execPath: process.execPath,
  }
}

function baseProbePolicy(writableRoots?: readonly string[]): SandboxPolicy {
  return {
    enabled: true,
    writableRoots: writableRoots ?? [tmpdir()],
    readIsolation: readIsolationFromEnv(process.env),
  }
}

function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'"'"'`)}'`
}

function runWrappedDefault(
  command: string,
  policy: SandboxPolicy,
  system: SandboxSystem,
): SpawnSyncReturns<string> {
  const wrapped = wrapBashCommand(command, policy, system)
  return spawnSync(wrapped.argv[0]!, wrapped.argv.slice(1), {
    encoding: 'utf8',
    timeout: 20_000,
  })
}

function runUnsandboxedDefault(command: string): SpawnSyncReturns<string> {
  return spawnSync('bash', ['--noprofile', '--norc', '-c', command], {
    encoding: 'utf8',
    timeout: 20_000,
  })
}

function spawnFailed(result: SpawnSyncReturns<string>): boolean {
  if (result.error) return true
  if (result.signal) return true
  return result.status === null
}

function negativeWriteProbeCommand(forbiddenFile: string): string {
  const target = shellQuote(forbiddenFile)
  return [
    `rm -f ${target}`,
    `if (echo ds-agent-sandbox-negative-probe > ${target}) 2>/dev/null; then`,
    `  if test -f ${target}; then exit ${EXIT_WRITE_SUCCEEDED_OUTSIDE}; fi`,
    `fi`,
    'exit 0',
  ].join('\n')
}

function writeDimensionFromNegativeStatus(status: number | null, spawnError: boolean): SandboxDimensionStatus {
  if (spawnError) return 'probe_failed'
  if (status === EXIT_WRITE_SUCCEEDED_OUTSIDE) return 'not_enforced'
  if (status === 0) return 'enforced'
  return 'probe_failed'
}

function probeReadIsolation(
  policy: SandboxPolicy,
  system: SandboxSystem,
  runWrapped: SandboxConfinementProbeHooks['runWrapped'],
  forbiddenFile: string,
): SandboxDimensionStatus {
  if (!policy.readIsolation) return 'not_tested'
  const runner = runWrapped ?? ((cmd, pol, sys) => runWrappedDefault(cmd, pol, sys))
  const path = shellQuote(forbiddenFile)
  const result = runner(`test -r ${path} && cat ${path} >/dev/null`, policy, system)
  if (spawnFailed(result)) return 'probe_failed'
  if (result.status === 0) return 'not_enforced'
  if (result.status !== 0) return 'enforced'
  return 'probe_failed'
}

const LOOPBACK_FIXTURE = join(import.meta.dirname, '../../test/fixtures/sandbox-loopback-server.mjs')

function withLoopbackFixture<T>(
  hooks: SandboxConfinementProbeHooks,
  _system: SandboxSystem,
  fn: (port: number) => T,
): T {
  if (hooks.loopbackPort !== undefined) return fn(hooks.loopbackPort)
  const portFile = join(tmpdir(), `ds-agent-sandbox-net-${process.pid}-${Date.now()}.port`)
  rmSync(portFile, { force: true })
  // Loopback fixture runs on the real host Node, not a synthetic probe execPath (e.g. unit tests).
  const child = spawn(process.execPath, [LOOPBACK_FIXTURE, portFile], {
    stdio: 'ignore',
    detached: false,
  })
  try {
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      if (existsSync(portFile)) {
        const raw = readFileSync(portFile, 'utf8').trim()
        const port = Number.parseInt(raw, 10)
        if (Number.isFinite(port) && port > 0) return fn(port)
      }
      spawnSync('sleep', ['0.02'], { stdio: 'ignore' })
    }
    throw new Error('loopback fixture did not publish a port')
  } finally {
    if (child.pid != null) {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
    rmSync(portFile, { force: true })
  }
}

function probeNetworkIsolation(
  policy: SandboxPolicy,
  system: SandboxSystem,
  hooks: SandboxConfinementProbeHooks,
): SandboxDimensionStatus {
  if (policy.allowNetwork === true) return 'unsupported'
  if (system.platform !== 'linux' && system.platform !== 'darwin') return 'unsupported'
  const runner = hooks.runWrapped ?? ((cmd, pol, sys) => runWrappedDefault(cmd, pol, sys))
  const node = shellQuote(system.execPath ?? process.execPath)
  const fetchCmd = (hostPort: string) =>
    `${node} -e "fetch('http://${hostPort}/').then(r=>r.ok?process.exit(0):process.exit(2)).catch(()=>process.exit(1))"`
  try {
    return withLoopbackFixture(hooks, system, port => {
      const target = `127.0.0.1:${port}`
      const positive = runner(fetchCmd(target), { ...policy, allowNetwork: true }, system)
      if (spawnFailed(positive) || positive.status !== 0) return 'probe_failed'
      const negative = runner(fetchCmd(target), { ...policy, allowNetwork: false }, system)
      if (spawnFailed(negative)) return 'probe_failed'
      if (negative.status === 0) return 'not_enforced'
      return 'enforced'
    })
  } catch {
    return 'probe_failed'
  }
}

function parseRequiredDimensionsEnv(env: NodeJS.ProcessEnv = process.env): Set<SandboxRequiredDimension> {
  const raw = env.DS_AGENT_SANDBOX_REQUIRED?.trim()
  if (raw === undefined || raw === '') return new Set()
  const out = new Set<SandboxRequiredDimension>()
  for (const token of raw.split(',').map(t => t.trim()).filter(Boolean)) {
    if (!REQUIRED_DIMENSIONS.has(token as SandboxRequiredDimension)) {
      throw new UserError(
        `invalid DS_AGENT_SANDBOX_REQUIRED token "${token}" (expected write, read, network, process)`,
      )
    }
    out.add(token as SandboxRequiredDimension)
  }
  return out
}

function isDimensionSatisfied(required: SandboxRequiredDimension, status: SandboxDimensionStatus): boolean {
  void required
  return status === 'enforced'
}

/**
 * Fail closed when the operator listed dimensions in `DS_AGENT_SANDBOX_REQUIRED`
 * and the latest host probe did not show enforcement for each one.
 * Default (unset env): write must be `enforced` only; `not_enforced`, `unsupported`, and `probe_failed` deny.
 */
export function assertRequiredSandboxDimensions(
  confinement: SandboxConfinementProbe,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const required = parseRequiredDimensionsEnv(env)
  const checks: SandboxRequiredDimension[]
    = required.size > 0
      ? [...required]
      : ['write']
  for (const dim of checks) {
    const status = dim === 'write'
      ? (confinement.dimensions.write === 'unsupported' || confinement.dimensions.write === 'probe_failed'
        ? confinement.outcome
        : confinement.dimensions.write)
      : confinement.dimensions[dim]
    if (!isDimensionSatisfied(dim, status)) {
      const label = required.size > 0 ? `required dimension ${dim}` : 'default write sandbox'
      throw new UserError(
        `${label} is not satisfied (status=${status}); refusing unconfined or unproven worker bash`,
      )
    }
  }
}

/** Run host confinement probe and fail closed when required dimensions are not met. */
export function enforceRequiredSandboxOnHost(
  env: NodeJS.ProcessEnv = process.env,
): SandboxConfinementProbe {
  const system: SandboxSystem = {
    platform: process.platform,
    available: bin => spawnSync('which', [bin], { stdio: 'ignore' }).status === 0,
    exists: existsSync,
    execPath: process.execPath,
  }
  const confinement = probeSandboxConfinement(system)
  assertRequiredSandboxDimensions(confinement, env)
  return confinement
}

/** Wrapped `kill -0 $$` should succeed; wrapped kill of parent pid should fail when process isolation holds. */
function probeProcessIsolation(
  policy: SandboxPolicy,
  system: SandboxSystem,
  runWrapped: SandboxConfinementProbeHooks['runWrapped'],
): SandboxDimensionStatus {
  if (system.platform !== 'linux') {
    // No host-safe wrapped parent-kill probe on Darwin without broader policy review.
    return 'unsupported'
  }
  const runner = runWrapped ?? ((cmd, pol, sys) => runWrappedDefault(cmd, pol, sys))
  const selfAlive = runner('kill -0 $$', policy, system)
  if (spawnFailed(selfAlive) || selfAlive.status !== 0) return 'probe_failed'
  const parentSignal = runner('kill -0 $PPID', policy, system)
  if (spawnFailed(parentSignal)) return 'probe_failed'
  if (parentSignal.status === 0) return 'not_enforced'
  return 'enforced'
}

function emptyDimensions(): SandboxConfinementDimensions {
  return { write: 'unsupported', read: 'unsupported', network: 'unsupported', process: 'unsupported' }
}

/**
 * Attempts to prove the wrapper actually constrains writes, not merely exists on PATH.
 * Outcome `enforced` means only that the write probe failed to create a file outside the
 * writable root; it does not prove read, network, or process isolation (see `dimensions`).
 */
export function probeSandboxConfinement(
  system: SandboxSystem = defaultSystem(),
  hooks: SandboxConfinementProbeHooks = {},
): SandboxConfinementProbe {
  const wrapper = probeSandboxWrapper(system)
  const dimensions = emptyDimensions()
  if (!wrapper.canWrap || !wrapper.wrapper) {
    return {
      platform: system.platform,
      wrapper: wrapper.wrapper,
      outcome: 'unsupported',
      positiveExecOk: false,
      positiveWriteOk: null,
      negativeWriteBlocked: null,
      unconfinedForbiddenWriteOk: null,
      dimensions,
      detail: 'no sandbox wrapper',
    }
  }

  const parent = mkdtempSync(join(tmpdir(), 'ds-agent-sandbox-probe-'))
  const workspace = join(parent, 'allowed')
  const forbiddenDir = join(parent, 'forbidden')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(forbiddenDir, { recursive: true })
  const forbiddenFile = join(forbiddenDir, 'probe-write.txt')
  const allowedMarker = join(workspace, 'positive-write.txt')
  const policy = baseProbePolicy([workspace])
  const runWrapped = hooks.runWrapped ?? ((cmd, pol, sys) => runWrappedDefault(cmd, pol, sys))
  const runUnsandboxed = hooks.runUnsandboxed ?? runUnsandboxedDefault

  try {
    const control = runUnsandboxed(
      `rm -f ${shellQuote(forbiddenFile)} && echo control > ${shellQuote(forbiddenFile)} && test -f ${shellQuote(forbiddenFile)}`,
    )
    const unconfinedForbiddenWriteOk = !spawnFailed(control) && control.status === 0
    if (!unconfinedForbiddenWriteOk) {
      return {
        platform: system.platform,
        wrapper: wrapper.wrapper,
        outcome: 'probe_failed',
        positiveExecOk: false,
        positiveWriteOk: null,
        negativeWriteBlocked: null,
        unconfinedForbiddenWriteOk: false,
        dimensions: { ...dimensions, write: 'probe_failed' },
        detail: 'unconfined control could not write forbidden sibling path',
      }
    }

    const positive = runWrapped('true', policy, system)
    const positiveExecOk = !spawnFailed(positive) && positive.status === 0
    if (!positiveExecOk) {
      dimensions.write = 'probe_failed'
      return {
        platform: system.platform,
        wrapper: wrapper.wrapper,
        outcome: 'probe_failed',
        positiveExecOk: false,
        positiveWriteOk: null,
        negativeWriteBlocked: null,
        unconfinedForbiddenWriteOk: true,
        dimensions,
        detail: String(positive.stderr ?? '').trim() || `wrapped positive exec exit ${positive.status}`,
      }
    }

    const positiveWrite = runWrapped(
      `echo ok > ${shellQuote(allowedMarker)} && test -f ${shellQuote(allowedMarker)}`,
      policy,
      system,
    )
    const positiveWriteOk = !spawnFailed(positiveWrite) && positiveWrite.status === 0
    if (!positiveWriteOk) {
      dimensions.write = 'probe_failed'
      return {
        platform: system.platform,
        wrapper: wrapper.wrapper,
        outcome: 'probe_failed',
        positiveExecOk: true,
        positiveWriteOk: false,
        negativeWriteBlocked: null,
        unconfinedForbiddenWriteOk: true,
        dimensions,
        detail: 'wrapped positive write inside writable root failed',
      }
    }

    rmSync(forbiddenFile, { force: true })
    const negative = runWrapped(negativeWriteProbeCommand(forbiddenFile), policy, system)
    const negativeSpawnError = spawnFailed(negative)
    dimensions.write = writeDimensionFromNegativeStatus(negative.status, negativeSpawnError)
    const negativeWriteBlocked = dimensions.write === 'enforced'
    const outcome: SandboxConfinementOutcome =
      dimensions.write === 'enforced' || dimensions.write === 'not_enforced' || dimensions.write === 'probe_failed'
        ? dimensions.write
        : 'probe_failed'

    const readPolicy: SandboxPolicy = { ...policy, readIsolation: true }
    dimensions.read = probeReadIsolation(readPolicy, system, hooks.runWrapped, forbiddenFile)
    dimensions.network = probeNetworkIsolation(policy, system, hooks)
    dimensions.process = probeProcessIsolation(policy, system, hooks.runWrapped)

    let detail: string
    if (outcome === 'enforced') {
      detail = 'wrapped write outside writable root rejected (write dimension only)'
    } else if (outcome === 'not_enforced') {
      detail = 'wrapped write outside writable root succeeded (no write confinement observed)'
    } else {
      detail = String(negative.stderr ?? '').trim()
        || `negative write probe exit ${negative.status ?? 'null'}`
    }

    return {
      platform: system.platform,
      wrapper: wrapper.wrapper,
      outcome,
      positiveExecOk: true,
      positiveWriteOk: true,
      negativeWriteBlocked,
      unconfinedForbiddenWriteOk: true,
      dimensions,
      detail,
    }
  } catch (error) {
    dimensions.write = 'probe_failed'
    return {
      platform: system.platform,
      wrapper: wrapper.wrapper,
      outcome: 'probe_failed',
      positiveExecOk: false,
      positiveWriteOk: null,
      negativeWriteBlocked: null,
      unconfinedForbiddenWriteOk: null,
      dimensions,
      detail: error instanceof Error ? error.message : String(error),
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

/** Convenience: run host probe only when a wrapper exists (logs to stdout). */
export function probeSandboxConfinementOnHost(): SandboxConfinementProbe {
  const system: SandboxSystem = {
    platform: process.platform,
    available: bin => spawnSync('which', [bin], { stdio: 'ignore' }).status === 0,
    exists: existsSync,
    execPath: process.execPath,
  }
  return probeSandboxConfinement(system)
}

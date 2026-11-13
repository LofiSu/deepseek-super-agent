import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
  /** Inject a known host PID instead of spawning the external fixture. */
  externalPid?: number
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
/**
 * Distinct from both 0 and `EXIT_WRITE_SUCCEEDED_OUTSIDE`: a wrapper that did
 * not mount the forbidden directory cannot prove a write was denied, so the
 * dimension must fail closed as `probe_failed` rather than `enforced`.
 */
const EXIT_FORBIDDEN_PARENT_INVISIBLE = 13

export function probeSandboxWrapper(
  system: SandboxSystem = defaultSystem(),
  probePolicy: SandboxPolicy = baseProbePolicy(),
): SandboxWrapperProbe {
  try {
    if (system.platform === 'darwin') {
      if (!system.available('sandbox-exec')) return { platform: system.platform, wrapper: null, canWrap: false }
      wrapBashCommand('true', probePolicy, system)
      return { platform: system.platform, wrapper: 'sandbox-exec', canWrap: true }
    }
    if (system.platform === 'linux') {
      if (!system.available('bwrap')) return { platform: system.platform, wrapper: null, canWrap: false }
      wrapBashCommand('true', probePolicy, system)
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

/** Policy used for worker bash and for host probes when LocalEnv enforces required dimensions. */
export function sandboxPolicyForProbe(
  effective: SandboxPolicy,
  writableRoots?: readonly string[],
): SandboxPolicy {
  return {
    enabled: effective.enabled,
    writableRoots: writableRoots ?? [tmpdir()],
    readIsolation: effective.readIsolation === true,
    readRoots: effective.readRoots,
    allowNetwork: effective.allowNetwork,
    unsharePid: effective.unsharePid === true,
  }
}

function baseProbePolicy(
  writableRoots?: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): SandboxPolicy {
  return sandboxPolicyForProbe(
    {
      enabled: true,
      readIsolation: readIsolationFromEnv(env),
    },
    writableRoots,
  )
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
  const parentDir = shellQuote(dirname(forbiddenFile))
  return [
    // A redirect into an unmounted parent fails because the directory is absent,
    // not because the sandbox denied the write. Require the parent to be visible.
    `test -d ${parentDir} || exit ${EXIT_FORBIDDEN_PARENT_INVISIBLE}`,
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
  runUnsandboxed: (command: string) => SpawnSyncReturns<string>,
  forbiddenFile: string,
): SandboxDimensionStatus {
  if (!policy.readIsolation) return 'not_tested'
  const runner = runWrapped ?? ((cmd, pol, sys) => runWrappedDefault(cmd, pol, sys))
  const path = shellQuote(forbiddenFile)
  const readCommand = `test -r ${path} && cat ${path} >/dev/null`
  // A canary whose parent directory was never mounted is absent, not hidden.
  // Require the parent to be visible inside the wrapper before crediting
  // read isolation, otherwise an unmounted path would read as `enforced`.
  const visibility = runner(`test -d ${shellQuote(dirname(forbiddenFile))}`, policy, system)
  if (spawnFailed(visibility) || visibility.status !== 0) return 'probe_failed'
  // Positive control: a wrapped read that fails proves isolation only when the
  // same file is readable unsandboxed. A missing canary means the earlier
  // negative-write probe removed it, not that the sandbox hid it.
  if (!existsSync(forbiddenFile)) return 'probe_failed'
  const control = runUnsandboxed(readCommand)
  if (spawnFailed(control) || control.status !== 0) return 'probe_failed'
  const result = runner(readCommand, policy, system)
  if (spawnFailed(result)) return 'probe_failed'
  if (result.status === 0) return 'not_enforced'
  return 'enforced'
}

/**
 * Fixtures are copied next to the compiled module by `scripts/copy-assets.ts`
 * (`src/env/fixtures` -> `dist/env/fixtures`). Resolving relative to this file
 * keeps the published package independent of the source-only `test/` tree.
 */
const LOOPBACK_FIXTURE = join(import.meta.dirname, 'fixtures', 'sandbox-loopback-server.mjs')
const EXTERNAL_PID_FIXTURE = join(import.meta.dirname, 'fixtures', 'sandbox-external-pid-fixture.mjs')

const FIXTURE_DEADLINE_MS = 8_000
/** First liveness check; an immediate module-not-found exit is caught here. */
const FIXTURE_FIRST_LIVENESS_CHECK_MS = 100
const FIXTURE_LIVENESS_INTERVAL_MS = 1_000

/** Paths of the host-side probe fixtures; exported for packaging checks. */
export function sandboxProbeFixturePaths(): { readonly loopback: string; readonly externalPid: string } {
  return { loopback: LOOPBACK_FIXTURE, externalPid: EXTERNAL_PID_FIXTURE }
}

/**
 * `ps -p <pid>` exits nonzero with empty stdout both when the pid is gone
 * (procps-ng) and when the invocation itself is unsupported (some BusyBox
 * builds reject `-o state=` / `-p`). Empty stderr does not separate the two.
 *
 * Run the exact argv once against our own pid: if that cannot be spawned,
 * exits nonzero, or yields no state, the invocation is unobservable and no
 * target-pid result can prove a fixture died. Cached because the executable
 * and argv do not change while this process runs.
 */
let psStateObservationSupported: boolean | undefined

function canObserveProcessState(): boolean {
  if (psStateObservationSupported !== undefined) return psStateObservationSupported
  const self = spawnSync('ps', ['-o', 'state=', '-p', String(process.pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  psStateObservationSupported
    = self.error === undefined
      && self.signal === null
      && self.status === 0
      && (self.stdout ?? '').trim() !== ''
  return psStateObservationSupported
}

/**
 * The poll loop sleeps with `spawnSync`, which starves libuv: the child's
 * `exit` event (and `child.exitCode`) cannot fire while we wait. Read the
 * process table synchronously instead, so a fixture that dies immediately
 * (for example a missing module in a broken package layout) fails fast rather
 * than waiting out the full deadline.
 */
function fixtureProcessExited(pid: number): boolean {
  // A `ps` that cannot report state also cannot prove the fixture died.
  if (!canObserveProcessState()) return false
  const result = spawnSync('ps', ['-o', 'state=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.error || result.signal) return false // interrupted; let the deadline decide
  const state = (result.stdout ?? '').trim()
  // The invocation is known to work against this process, so an empty state
  // now means the pid is gone (procps-ng exits 1) and `Z*` means it exited
  // but has not been reaped yet. Both are safe to fail fast on.
  return state === '' || state.startsWith('Z')
}

/** Wait for a fixture to write `file`, failing fast when its process dies. */
function waitForFixtureOutput<T>(
  child: ReturnType<typeof spawn>,
  file: string,
  label: string,
  parse: (raw: string) => T | undefined,
): T {
  if (child.pid == null) throw new Error(`${label} fixture failed to start`)
  const pid = child.pid
  const deadline = Date.now() + FIXTURE_DEADLINE_MS
  let nextLivenessCheck = Date.now() + FIXTURE_FIRST_LIVENESS_CHECK_MS
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const value = parse(readFileSync(file, 'utf8'))
      if (value !== undefined) return value
    }
    if (Date.now() >= nextLivenessCheck) {
      if (fixtureProcessExited(pid)) {
        throw new Error(`${label} fixture exited before writing ${file}`)
      }
      nextLivenessCheck = Date.now() + FIXTURE_LIVENESS_INTERVAL_MS
    }
    spawnSync('sleep', ['0.02'], { stdio: 'ignore' })
  }
  throw new Error(`${label} fixture did not write ${file}`)
}

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
    return fn(waitForFixtureOutput(child, portFile, 'loopback', (raw) => {
      const port = Number.parseInt(raw.trim(), 10)
      return Number.isFinite(port) && port > 0 ? port : undefined
    }))
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

function isDimensionSatisfied(
  required: SandboxRequiredDimension,
  status: SandboxDimensionStatus,
  effective: SandboxPolicy,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (required === 'read' && effective.readIsolation !== true) return false
  if (required === 'process' && platform === 'linux' && effective.unsharePid !== true) return false
  return status === 'enforced'
}

/**
 * Fail closed when the operator listed dimensions in `DS_AGENT_SANDBOX_REQUIRED`
 * and the latest host probe did not show enforcement for each one under `effectivePolicy`
 * (the same policy LocalEnv will use for worker bash — not a stricter probe-only profile).
 * Default (unset env): write must be `enforced` only; `not_enforced`, `unsupported`,
 * `not_tested`, and `probe_failed` deny.
 */
export function assertRequiredSandboxDimensions(
  confinement: SandboxConfinementProbe,
  env: NodeJS.ProcessEnv = process.env,
  effectivePolicy: SandboxPolicy = { enabled: true },
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
    if (!isDimensionSatisfied(dim, status, effectivePolicy, confinement.platform as NodeJS.Platform)) {
      const label = required.size > 0 ? `required dimension ${dim}` : 'default write sandbox'
      const reported = dim === 'read' && effectivePolicy.readIsolation !== true
        ? 'not_enforced'
        : dim === 'process' && confinement.platform === 'linux' && effectivePolicy.unsharePid !== true
          ? 'not_enforced'
          : status
      throw new UserError(
        `${label} is not satisfied (status=${reported}); refusing unconfined or unproven worker bash`,
      )
    }
  }
}

/**
 * Run host confinement probe under the effective LocalEnv sandbox policy and fail
 * closed when required dimensions are not met. Refuses when sandbox is disabled.
 */
export function enforceRequiredSandbox(
  env: NodeJS.ProcessEnv,
  effectivePolicy: SandboxPolicy,
): SandboxConfinementProbe {
  if (effectivePolicy.enabled === false) {
    throw new UserError(
      'required sandbox dimensions cannot be satisfied while sandbox is disabled (sandbox.enabled: false)',
    )
  }
  const system: SandboxSystem = {
    platform: process.platform,
    available: bin => spawnSync('which', [bin], { stdio: 'ignore' }).status === 0,
    exists: existsSync,
    execPath: process.execPath,
  }
  const confinement = probeSandboxConfinement(system, {}, effectivePolicy)
  assertRequiredSandboxDimensions(confinement, env, effectivePolicy)
  return confinement
}

/** @deprecated Prefer `enforceRequiredSandbox(env, effectivePolicy)` from LocalEnv. */
export function enforceRequiredSandboxOnHost(
  env: NodeJS.ProcessEnv = process.env,
): SandboxConfinementProbe {
  return enforceRequiredSandbox(env, baseProbePolicy(undefined, env))
}

/**
 * Process isolation: `kill -0 $PPID` inside wrapped bash targets the sandbox
 * parent (often the worker shell), not the host daemon — a false negative.
 * The owned external PID fixture is the positive control for host visibility.
 */
function probeProcessIsolation(
  policy: SandboxPolicy,
  system: SandboxSystem,
  runWrapped: SandboxConfinementProbeHooks['runWrapped'],
  hooks: SandboxConfinementProbeHooks,
): SandboxDimensionStatus {
  if (system.platform !== 'linux') {
    return 'unsupported'
  }
  if (policy.unsharePid !== true) return 'not_tested'
  const runner = runWrapped ?? ((cmd, pol, sys) => runWrappedDefault(cmd, pol, sys))
  const runUnsandboxed = hooks.runUnsandboxed ?? runUnsandboxedDefault
  const selfAlive = runner('kill -0 $$', policy, system)
  if (spawnFailed(selfAlive) || selfAlive.status !== 0) return 'probe_failed'

  const pidFile = join(tmpdir(), `ds-agent-sandbox-extpid-${process.pid}-${Date.now()}.json`)
  rmSync(pidFile, { force: true })
  let child: ReturnType<typeof spawn> | undefined
  try {
    if (hooks.externalPid !== undefined) {
      const ext = hooks.externalPid
      const wrapped = runner(`kill -0 ${ext}`, policy, system)
      if (spawnFailed(wrapped)) return 'probe_failed'
      return wrapped.status === 0 ? 'not_enforced' : 'enforced'
    }
    child = spawn(process.execPath, [EXTERNAL_PID_FIXTURE, pidFile], { stdio: 'ignore' })
    const externalPid = waitForFixtureOutput(child, pidFile, 'external PID', (raw) => {
      try {
        const parsed = JSON.parse(raw) as { pid?: number }
        return typeof parsed.pid === 'number' ? parsed.pid : undefined
      } catch {
        return undefined // partial write; retry until the deadline
      }
    })
    const control = runUnsandboxed(`kill -0 ${externalPid}`)
    if (spawnFailed(control) || control.status !== 0) return 'probe_failed'
    const wrapped = runner(`kill -0 ${externalPid}`, policy, system)
    if (spawnFailed(wrapped)) return 'probe_failed'
    return wrapped.status === 0 ? 'not_enforced' : 'enforced'
  } catch {
    return 'probe_failed'
  } finally {
    if (child?.pid != null) {
      try {
        child.kill('SIGTERM')
      } catch {
        /* gone */
      }
    }
    rmSync(pidFile, { force: true })
  }
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
  effectivePolicy: SandboxPolicy = baseProbePolicy(),
): SandboxConfinementProbe {
  const wrapperPolicy = sandboxPolicyForProbe(effectivePolicy)
  const wrapper = probeSandboxWrapper(system, { ...wrapperPolicy, enabled: true })
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
  const policy = sandboxPolicyForProbe(effectivePolicy, [workspace])
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

    try {
      writeFileSync(forbiddenFile, 'ds-agent-read-canary')
    } catch {
      // Leave the canary missing: the read probe's positive control then fails
      // closed without changing the already-computed write dimension.
    }
    dimensions.read = probeReadIsolation(
      policy,
      system,
      hooks.runWrapped,
      runUnsandboxed,
      forbiddenFile,
    )
    dimensions.network = probeNetworkIsolation(policy, system, hooks)
    dimensions.process = probeProcessIsolation(policy, system, hooks.runWrapped, hooks)

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

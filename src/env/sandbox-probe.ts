import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
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

/** Host execution probe: positive exec + negative write outside writable root. */
export interface SandboxConfinementProbe {
  platform: string
  wrapper: SandboxWrapperProbe['wrapper']
  outcome: SandboxConfinementOutcome
  /** Wrapped `true` exited 0. */
  positiveExecOk: boolean
  /** Wrapped write outside workspace failed (non-zero / signal). Null when unsupported. */
  negativeWriteBlocked: boolean | null
  detail?: string
}

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

function runWrapped(command: string, policy: SandboxPolicy, system: SandboxSystem): ReturnType<typeof spawnSync> {
  const wrapped = wrapBashCommand(command, policy, system)
  return spawnSync(wrapped.argv[0]!, wrapped.argv.slice(1), {
    encoding: 'utf8',
    timeout: 20_000,
  })
}

/**
 * Attempts to prove the wrapper actually constrains writes, not merely exists on PATH.
 * Does not relax privileges; returns unsupported when no wrapper or host blocks spawn.
 */
export function probeSandboxConfinement(system: SandboxSystem = defaultSystem()): SandboxConfinementProbe {
  const wrapper = probeSandboxWrapper(system)
  if (!wrapper.canWrap || !wrapper.wrapper) {
    return {
      platform: system.platform,
      wrapper: wrapper.wrapper,
      outcome: 'unsupported',
      positiveExecOk: false,
      negativeWriteBlocked: null,
      detail: 'no sandbox wrapper',
    }
  }

  const workspace = mkdtempSync(join(tmpdir(), 'ds-agent-sandbox-probe-'))
  const forbidden = '/ds-agent-sandbox-write-probe-forbidden'
  const policy = baseProbePolicy([workspace])
  try {
    const positive = runWrapped('true', policy, system)
    const positiveExecOk = positive.status === 0
    if (!positiveExecOk) {
      return {
        platform: system.platform,
        wrapper: wrapper.wrapper,
        outcome: 'probe_failed',
        positiveExecOk: false,
        negativeWriteBlocked: null,
        detail: String(positive.stderr ?? '').trim() || `positive exit ${positive.status}`,
      }
    }

    const negative = runWrapped(
      `echo probe > ${forbidden} 2>/dev/null || exit 1; test ! -f ${forbidden}`,
      policy,
      system,
    )
    const negativeWriteBlocked = negative.status !== 0
    const outcome: SandboxConfinementOutcome = negativeWriteBlocked ? 'enforced' : 'not_enforced'
    return {
      platform: system.platform,
      wrapper: wrapper.wrapper,
      outcome,
      positiveExecOk: true,
      negativeWriteBlocked,
      detail: negativeWriteBlocked
        ? 'wrapped write outside writable root rejected'
        : 'wrapped write outside writable root succeeded (no confinement observed)',
    }
  } catch (error) {
    return {
      platform: system.platform,
      wrapper: wrapper.wrapper,
      outcome: 'probe_failed',
      positiveExecOk: false,
      negativeWriteBlocked: null,
      detail: error instanceof Error ? error.message : String(error),
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}


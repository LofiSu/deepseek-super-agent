import fs from 'node:fs'
import path from 'node:path'
import { readIsolationFromEnv, sandboxEnabledFromEnv } from '../env/seccomp.ts'
import type { MachineRegistry } from '../harness/machines.ts'
import type { Ticket } from '../shared/types.ts'
import type { Store } from '../store/sqlite.ts'
import { stuckAssignments, stuckSessions } from './watchdog.ts'

/** A capability this process asked for. `unknown` means the probe could not tell. */
export type CapabilityState = 'on' | 'off' | 'unknown'

/**
 * The env/config signal is a request, not proof: a sandboxed shell may still be
 * unavailable on the host. Health does not execute a shell, so enforcement is
 * deliberately reported as `unknown` rather than claimed.
 */
export interface RequestedCapability {
  requested: CapabilityState
  enforced: 'unknown'
}

/** JSON-safe, secret-free capability view for operators and bug reports. */
export interface HealthCapabilities {
  /** Store schema recorded by the database, or `unknown` when it cannot be read. */
  schemaVersion: number | 'unknown'
  /** Strict read confinement requested through `DS_AGENT_SANDBOX_READ_ISOLATION`. */
  readIsolation: RequestedCapability
  /** Worker bash sandbox requested through the default-on sandbox policy. */
  workerSandbox: RequestedCapability
  /** This build delivers A2A envelopes in-process; no HTTP listener is wired. */
  a2aTransport: 'in-process'
  /** Worker mesh placement is in-process; no network transport is wired. */
  meshTransport: 'in-process'
}

export interface HealthSnapshot {
  store: string
  vaultMode: 'absent' | 'ok' | 'insecure'
  machinesOnline: number
  watchdogIdle: boolean
  capabilities: HealthCapabilities
}

function schemaVersionOf(store: Store): number | 'unknown' {
  try {
    // A closed Store still exposes its last version; report `unknown` because
    // it can no longer be verified against the live database.
    if (!store.isOpen) return 'unknown'
    const version = store.schemaVersion
    return typeof version === 'number' && Number.isSafeInteger(version) && version >= 0
      ? version
      : 'unknown'
  } catch {
    return 'unknown'
  }
}

function requestedReadIsolation(): CapabilityState {
  try {
    return readIsolationFromEnv(process.env) ? 'on' : 'off'
  } catch {
    // The existing parser fails closed on an unrecognized value.
    return 'unknown'
  }
}

function requestedWorkerSandbox(): CapabilityState {
  try {
    return sandboxEnabledFromEnv(process.env) ? 'on' : 'off'
  } catch {
    return 'unknown'
  }
}

function capabilityView(store: Store): HealthCapabilities {
  // `credentialSource` is intentionally omitted: no existing helper can name
  // the source without reading credential values.
  return {
    schemaVersion: schemaVersionOf(store),
    readIsolation: { requested: requestedReadIsolation(), enforced: 'unknown' },
    workerSandbox: { requested: requestedWorkerSandbox(), enforced: 'unknown' },
    a2aTransport: 'in-process',
    meshTransport: 'in-process',
  }
}

function onlineMachines(machines?: MachineRegistry): number {
  try {
    return machines?.list().filter(machine => machine.status === 'online').length ?? 0
  } catch {
    return 0
  }
}

/**
 * Read-only snapshot; no vault values or runtime startup. The four original
 * fields keep their values and types; `capabilities` is purely additive and
 * safe to paste into a bug report.
 */
export function healthProbe(store: Store, home: string, machines?: MachineRegistry): HealthSnapshot {
  const vaultPath = path.join(home, 'vault.json')
  const vaultMode = fs.existsSync(vaultPath)
    ? (fs.statSync(vaultPath).mode & 0o077) === 0 ? 'ok' : 'insecure'
    : 'absent'
  let storeState = 'error'
  try {
    storeState = store.health()
  } catch {
    // Keep the store error signal rather than failing the whole probe.
  }
  // On a store read failure, fail closed: never claim the watchdog is idle.
  let watchdogIdle = false
  if (storeState === 'ok') {
    try {
      const now = Date.now()
      const tickets = store.listDocs<Ticket>('ticket')
      const paused = new Set(tickets.filter(ticket => ticket.collab?.paused).map(ticket => ticket.id))
      const sessions = store.listSessions().filter(session =>
        !(session.ticketId != null && paused.has(session.ticketId)))
      watchdogIdle = stuckAssignments(tickets, store.listJobs(), now, 60_000).length === 0
        && stuckSessions(sessions, now, 60_000).length === 0
    } catch {
      watchdogIdle = false
    }
  }
  return {
    store: storeState,
    vaultMode,
    machinesOnline: onlineMachines(machines),
    watchdogIdle,
    capabilities: capabilityView(store),
  }
}

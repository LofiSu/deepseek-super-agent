import type { Decision, ReceiveResult, Role, Trigger } from './types.ts'

/** Scope port: whether a source listens to this trigger. */
export interface SourceScope {
  admit(trigger: Trigger): { listened: boolean; reason: string }
}

export interface SpillPort {
  put(body: string): string
  get(id: string): string | undefined
}

export interface EnvRunOptions {
  /** Speculative sessions execute under a scratch workdir that can be rolled back. */
  isolated?: boolean
}

/** Where a future cloud worker would plug in beside LocalEnv. */
export interface EnvPort {
  bash(workerId: string, command: string, opts?: EnvRunOptions): Promise<{ code: number; stdout: string; stderr: string }>
  writeFile(workerId: string, relativePath: string, body: string, opts?: EnvRunOptions): Promise<string>
  readFile(workerId: string, relativePath: string, opts?: EnvRunOptions): Promise<string>
  /** Delete a speculative scratch workspace. Presence means bash/write can be isolated. */
  discardIsolated?(workerId: string): void
  /** Move a speculative scratch workspace into the durable worker directory. */
  promoteIsolated?(workerId: string): void
}

/** Progress a worker is allowed to record. Delivery still goes out through the router. */
export interface WorkerReport {
  kind: string
  text: string
  deliver?: boolean
}

/** Router assessment handed to `decide`. Workers never construct this call. */
export type AssessmentOutcome =
  | { kind: 'ignore'; reason: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'accept'; reason: string }
  | { kind: 'stop'; ticketId: string; reason: string }

export const rolePortBrand: unique symbol = Symbol('rolePort')

/**
 * Commands a router session may use.
 * `reply`, `decide`, and `receive` live only here.
 */
export interface RouterPorts {
  readonly [rolePortBrand]: 'router'
  receive(trigger: Trigger): ReceiveResult
  decide(triggerId: string, outcome: AssessmentOutcome): Decision
  reply(ticketId: string, text: string, purpose: string): void
  /** End a live ticket and its running assignment. Router-owned. */
  stop(ticketId: string, reason: string): void
  subscribe(ticketId: string, threadKey: string, opts?: { contextOnly?: boolean }): void
  /** Stop following a thread without requeueing a trigger (compare `handback`). */
  unsubscribe(ticketId: string, threadKey: string, reason?: string): boolean
}

/**
 * Commands a worker session may use.
 * There is no `reply`, `decide`, or `receive` on this surface.
 */
export interface WorkerPorts {
  readonly [rolePortBrand]: 'worker'
  report(ticketId: string, report: WorkerReport): {
    surfaced: boolean
    verdict: 'deliver' | 'discard' | 'hold'
  }
  subscribe(ticketId: string, threadKey: string, opts?: { contextOnly?: boolean }): void
  /** Stop following a thread without requeueing a trigger (compare `handback`). */
  unsubscribe(ticketId: string, threadKey: string, reason?: string): boolean
  handback(ticketId: string, triggerId: string, reason: string): boolean
}

/**
 * Commands a watchdog session may use.
 * It can fail a stuck assignment. It cannot speak, intake, or assess.
 */
export interface WatchdogPorts {
  readonly [rolePortBrand]: 'watchdog'
  fail(ticketId: string, reason: string): {
    surfaced: boolean
    verdict: 'deliver' | 'discard' | 'hold'
  }
}

export interface RolePorts {
  router: RouterPorts
  worker: WorkerPorts
  watchdog: WatchdogPorts
}

/** Engine commands that must not run as a worker or a watchdog. */
export const ROUTER_ONLY_OPS = ['reply', 'decide', 'receive', 'stop'] as const
export type RouterOnlyOp = typeof ROUTER_ONLY_OPS[number]

/** Compile-time map so a role's port never gains a router-only command by accident. */
export type RolePortFor<R extends Role> = R extends 'router'
  ? RouterPorts
  : R extends 'worker'
    ? WorkerPorts
    : WatchdogPorts

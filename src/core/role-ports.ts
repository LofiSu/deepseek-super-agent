import { UserError } from '../shared/errors.ts'
import {
  rolePortBrand,
  ROUTER_ONLY_OPS,
  type AssessmentOutcome,
  type RolePorts,
  type RouterOnlyOp,
  type RouterPorts,
  type WatchdogPorts,
  type WorkerPorts,
  type WorkerReport,
} from '../shared/ports.ts'
import type { ReceiveResult, Trigger } from '../shared/types.ts'
import type { Engine } from './engine.ts'

/**
 * Slice the engine into the three session surfaces.
 * The objects workers and the watchdog hold do not carry reply, decide, or receive.
 * Reading those names returns a function that throws.
 */
export function bindRolePorts(engine: Engine): RolePorts {
  const routerMethods: Omit<RouterPorts, typeof rolePortBrand> = {
    receive: (trigger: Trigger): ReceiveResult => engine.receive(trigger),
    decide: (triggerId: string, outcome: AssessmentOutcome) => engine.decide(triggerId, outcome),
    reply: (ticketId: string, text: string, purpose: string, threadKey?: string): void => {
      engine.reply(ticketId, text, purpose, threadKey)
    },
    stop: (ticketId: string, reason: string): void => {
      engine.stop(ticketId, reason)
    },
    subscribe: (ticketId: string, threadKey: string, opts?: { contextOnly?: boolean }): void => {
      engine.subscribe(ticketId, threadKey, opts)
    },
    unsubscribe: (ticketId: string, threadKey: string, reason?: string): boolean => (
      engine.unsubscribe(ticketId, threadKey, reason)
    ),
  }
  const workerMethods: Omit<WorkerPorts, typeof rolePortBrand> = {
    report: (ticketId: string, report: WorkerReport) => engine.report(ticketId, report),
    subscribe: (ticketId: string, threadKey: string, opts?: { contextOnly?: boolean }): void => {
      engine.subscribe(ticketId, threadKey, opts)
    },
    unsubscribe: (ticketId: string, threadKey: string, reason?: string): boolean => (
      engine.unsubscribe(ticketId, threadKey, reason)
    ),
    handback: (ticketId: string, triggerId: string, reason: string): boolean => (
      engine.handback(ticketId, triggerId, reason)
    ),
  }
  const watchdogMethods: Omit<WatchdogPorts, typeof rolePortBrand> = {
    fail: (ticketId: string, reason: string) => engine.report(ticketId, {
      kind: 'failed',
      text: reason,
      deliver: false,
    }),
  }
  return {
    router: seal('router', routerMethods, []),
    worker: seal('worker', workerMethods, ROUTER_ONLY_OPS),
    watchdog: seal('watchdog', watchdogMethods, ROUTER_ONLY_OPS),
  }
}

function seal<R extends 'router' | 'worker' | 'watchdog', T extends object>(
  role: R,
  methods: T,
  denied: readonly RouterOnlyOp[],
): T & { readonly [rolePortBrand]: R } {
  const deniedSet = new Set<string>(denied)
  const target: T & { readonly [rolePortBrand]: R } = {
    ...methods,
    [rolePortBrand]: role,
  }
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === 'string' && deniedSet.has(prop)) {
        return refuse(role, prop)
      }
      const value = Reflect.get(obj, prop, receiver)
      return typeof value === 'function' ? value.bind(obj) : value
    },
    has(obj, prop) {
      if (typeof prop === 'string' && deniedSet.has(prop)) return true
      return Reflect.has(obj, prop)
    },
    set() {
      throw new UserError(`${role} ports are sealed`)
    },
  })
}

function refuse(role: 'router' | 'worker' | 'watchdog', op: string): () => never {
  return () => {
    throw new UserError(`${role} cannot ${op}`)
  }
}

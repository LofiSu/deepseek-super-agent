import { AsyncLocalStorage } from 'node:async_hooks'
import { UserError } from '../shared/errors.ts'
import type { RouterOnlyOp } from '../shared/ports.ts'
import type { Role } from '../shared/types.ts'

const current = new AsyncLocalStorage<Role>()

/** Run `fn` as a router, worker, or watchdog session. Nested calls switch the role. */
export function withSessionRole<T>(role: Role, fn: () => T): T {
  return current.run(role, fn)
}

/**
 * `reply`, `decide`, and `receive` belong to the router.
 * Outside a session (ingress, launch, tests) the caller is trusted.
 * Inside a worker or watchdog turn the call is refused before any write.
 */
export function assertSessionMay(op: RouterOnlyOp): void {
  const role = current.getStore()
  if (role == null || role === 'router') return
  throw new UserError(`${role} cannot ${op}`)
}

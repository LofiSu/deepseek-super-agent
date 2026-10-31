import type { SpillPort } from '../shared/ports.ts'
import type { Store } from './sqlite.ts'

/** Spill port over the SQLite blob table. Bodies outlive the process. */
export function spillPort(store: Store): SpillPort {
  return {
    put: body => store.putSpill(body),
    get: id => store.getSpill(id),
  }
}

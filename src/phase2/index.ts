import type { Trigger } from '../shared/types.ts'
import type { Store } from '../store/sqlite.ts'
import type {
  A2AEnvelope,
  LongTermMemoryQuery,
  ProductShellEvent,
  RouterShard,
  WorkerMeshNode,
} from './types.ts'
import { A2ARouter } from './a2a.ts'
import { SpillBackedLongTermMemory } from './long-term-memory.ts'
import { ProductShellBus } from './product-shell.ts'
import { RouterShardRegistry } from './router-shard.ts'
import { WorkerMeshRegistry } from './worker-mesh.ts'

export { A2ARouter } from './a2a.ts'
export { SpillBackedLongTermMemory } from './long-term-memory.ts'
export { ProductShellBus } from './product-shell.ts'
export { RouterShardRegistry } from './router-shard.ts'
export { WorkerMeshRegistry } from './worker-mesh.ts'

export type {
  A2AEnvelope,
  LongTermMemoryEntry,
  LongTermMemoryQuery,
  ProductShellEvent,
  RouterShard,
  WorkerMeshNode,
} from './types.ts'

/** @deprecated stubs removed; kept for import compatibility with older call sites */
export class Phase2NotImplementedError extends Error {
  constructor(feature: string) {
    super(`Phase-2 feature not implemented: ${feature}`)
    this.name = 'Phase2NotImplementedError'
  }
}

export function notImplemented(feature: string): never {
  throw new Phase2NotImplementedError(feature)
}

const routerShards = new RouterShardRegistry()
const productShellBus = new ProductShellBus()
const a2aRouter = new A2ARouter()

/**
 * Opt-in Phase-2 registries. Runtime does not call these unless the host wires them.
 */
export const phase2 = {
  productShellBus,
  a2aRouter,
  routerShard(shard: RouterShard): void {
    routerShards.register(shard)
  },
  route(trigger: Trigger): string[] {
    return routerShards.route(trigger)
  },
  workerMesh(node: WorkerMeshNode): WorkerMeshRegistry {
    const mesh = new WorkerMeshRegistry()
    mesh.register(node)
    return mesh
  },
  longTermMemory(store: Store): SpillBackedLongTermMemory {
    return new SpillBackedLongTermMemory(store)
  },
  productShell(event: ProductShellEvent): ProductShellEvent {
    return productShellBus.publish(event)
  },
  a2a(envelope: A2AEnvelope): A2AEnvelope {
    return a2aRouter.route(envelope)
  },
}

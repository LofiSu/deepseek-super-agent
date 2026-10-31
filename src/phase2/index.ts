import type {
  A2AEnvelope,
  LongTermMemoryQuery,
  ProductShellEvent,
  RouterShard,
  WorkerMeshNode,
} from './types.ts'

export type {
  A2AEnvelope,
  LongTermMemoryQuery,
  ProductShellEvent,
  RouterShard,
  WorkerMeshNode,
} from './types.ts'

export class Phase2NotImplementedError extends Error {
  constructor(feature: string) {
    super(`Phase-2 feature not implemented: ${feature}`)
    this.name = 'Phase2NotImplementedError'
  }
}

export function notImplemented(feature: string): never {
  throw new Phase2NotImplementedError(feature)
}

export const phase2 = {
  routerShard(_shard: RouterShard): never {
    return notImplemented('RouterShard (T09/T46)')
  },
  workerMesh(_node: WorkerMeshNode): never {
    return notImplemented('WorkerMesh (T47)')
  },
  longTermMemory(_query: LongTermMemoryQuery): never {
    return notImplemented('LongTermMemory (T48)')
  },
  productShell(_event: ProductShellEvent): never {
    return notImplemented('ProductShell (T49)')
  },
  a2a(_envelope: A2AEnvelope): never {
    return notImplemented('A2A (T50)')
  },
}

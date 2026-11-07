import type { A2ADelivery } from '../channels/a2a.ts'
import type { A2ASecret } from '../channels/a2a-auth.ts'
import { RemoteMeshRegistry, type RemoteNodeRegistration } from './remote-node.ts'
import { WorkerMeshRegistry } from './mesh.ts'

/** One remote peer from `DS_AGENT_REMOTE_MESH` JSON. Secrets stay env-local only. */
export interface RemoteMeshEnvNode {
  id: string
  url: string
  peerId: string
  secret: A2ASecret
  capacity?: number
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Parse `DS_AGENT_REMOTE_MESH` (JSON array). Malformed config logs and yields []. */
export function parseRemoteMeshNodesFromEnv(env: NodeJS.ProcessEnv): RemoteMeshEnvNode[] {
  const raw = env.DS_AGENT_REMOTE_MESH?.trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const nodes: RemoteMeshEnvNode[] = []
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue
      const row = item as Record<string, unknown>
      if (!nonEmpty(row.id) || !nonEmpty(row.url) || !nonEmpty(row.peerId) || row.secret == null) continue
      nodes.push({
        id: row.id,
        url: row.url,
        peerId: row.peerId,
        secret: row.secret as A2ASecret,
        capacity: typeof row.capacity === 'number' ? row.capacity : undefined,
      })
    }
    return nodes
  } catch {
    return []
  }
}

/**
 * Unified logical placement across the in-process node and optional remote peers.
 * Release always clears both registries for a ticket.
 */
export class WorkerPlacement {
  private remoteRegistry?: RemoteMeshRegistry

  get remote(): RemoteMeshRegistry | undefined {
    return this.remoteRegistry
  }

  constructor(
    readonly localNodeId: string,
    readonly local: WorkerMeshRegistry,
    remote?: RemoteMeshRegistry,
  ) {
    this.remoteRegistry = remote
  }

  /** Register a remote peer after worker inbox URL is known (tests / late bind). */
  registerRemoteNode(node: RemoteNodeRegistration): void {
    const registry = this.remoteRegistry ?? new RemoteMeshRegistry({ localPeerId: this.localNodeId })
    if (!this.remoteRegistry) this.remoteRegistry = registry
    registry.register(node)
  }

  static fromEnv(
    env: NodeJS.ProcessEnv,
    localNodeId: string,
    local: WorkerMeshRegistry,
    log: (line: string) => void,
  ): WorkerPlacement {
    const nodes = parseRemoteMeshNodesFromEnv(env)
    if (nodes.length === 0) return new WorkerPlacement(localNodeId, local)
    const remote = new RemoteMeshRegistry({ localPeerId: localNodeId })
    for (const node of nodes) {
      try {
        remote.register(node)
        log(`[mesh] remote registered id=${node.id} url=${node.url}`)
      } catch (error) {
        log(`[mesh] remote register failed id=${node.id} error=${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return new WorkerPlacement(localNodeId, local, remote)
  }

  pickNode(ticketId: string): string | undefined {
    const localNode = this.local.pickNode(ticketId)
    if (localNode) return localNode.id
    return this.remote?.pick(ticketId)?.id
  }

  release(ticketId: string): void {
    this.local.release(ticketId)
    this.remote?.release(ticketId)
  }

  isRemote(nodeId: string | undefined): boolean {
    if (!nodeId || nodeId === this.localNodeId) return false
    return !!this.remote?.get(nodeId)
  }

  dispatch(ticketId: string, assignment: unknown): Promise<A2ADelivery | undefined> {
    return this.remote?.dispatch(ticketId, assignment) ?? Promise.resolve(undefined)
  }
}

export function registerRemoteNodes(
  registry: RemoteMeshRegistry,
  nodes: readonly RemoteNodeRegistration[],
): void {
  for (const node of nodes) registry.register(node)
}

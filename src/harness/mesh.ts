/** A Worker node advertised to the mesh. */
export interface WorkerMeshNode {
  id: string
  capacity: number
  online?: boolean
}

/**
 * Capacity accounting for Worker placement (T47). Placement is logical: this
 * process still executes the turn; a remote hands transport is an integration
 * concern outside this repo.
 */
export class WorkerMeshRegistry {
  private readonly nodes = new Map<string, WorkerMeshNode>()
  private readonly assignments = new Map<string, string>()

  constructor(nodes: readonly WorkerMeshNode[] = []) {
    for (const node of nodes) this.register(node)
  }

  register(node: WorkerMeshNode): void {
    if (!node.id || !Number.isSafeInteger(node.capacity) || node.capacity < 1) {
      throw new Error('Worker mesh node requires an id and positive integer capacity')
    }
    if (this.nodes.has(node.id)) throw new Error(`Worker mesh node already registered: ${node.id}`)
    this.nodes.set(node.id, { ...node, online: node.online !== false })
  }

  unregister(nodeId: string): void {
    this.nodes.delete(nodeId)
    for (const [ticketId, assigned] of this.assignments) {
      if (assigned === nodeId) this.assignments.delete(ticketId)
    }
  }

  markOnline(nodeId: string, online: boolean): void {
    const node = this.nodes.get(nodeId)
    if (node) node.online = online
  }

  /** Least-loaded online node with free capacity. A ticket keeps its node on repeat picks. */
  pickNode(ticketId: string): WorkerMeshNode | undefined {
    const assignedId = this.assignments.get(ticketId)
    if (assignedId) {
      const node = this.nodes.get(assignedId)
      return node?.online === false ? undefined : node ? { ...node } : undefined
    }
    let best: WorkerMeshNode | undefined
    let bestLoad = Number.POSITIVE_INFINITY
    for (const node of this.nodes.values()) {
      if (node.online === false) continue
      const load = this.inFlight(node.id)
      if (load >= node.capacity || load >= bestLoad) continue
      best = node
      bestLoad = load
    }
    if (!best) return undefined
    this.assignments.set(ticketId, best.id)
    return { ...best }
  }

  release(ticketId: string): void {
    this.assignments.delete(ticketId)
  }

  inFlight(nodeId: string): number {
    let count = 0
    for (const assignedId of this.assignments.values()) {
      if (assignedId === nodeId) count++
    }
    return count
  }

  list(): WorkerMeshNode[] {
    return [...this.nodes.values()].map(node => ({ ...node }))
  }
}

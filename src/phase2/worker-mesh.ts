import type { WorkerMeshNode } from './types.ts'

/** In-memory, opt-in capacity accounting for Worker placement. */
export class WorkerMeshRegistry {
  private readonly nodes = new Map<string, WorkerMeshNode>()
  private readonly assignments = new Map<string, string>()

  register(node: WorkerMeshNode): void {
    if (!node.id || !Number.isSafeInteger(node.capacity) || node.capacity < 1) {
      throw new Error('Worker mesh node requires an id and positive integer capacity')
    }
    if (this.nodes.has(node.id)) throw new Error(`Worker mesh node already registered: ${node.id}`)
    this.nodes.set(node.id, { ...node })
  }

  pickNode(ticketId: string): WorkerMeshNode | undefined {
    const assignedId = this.assignments.get(ticketId)
    if (assignedId) return { ...this.nodes.get(assignedId)! }
    for (const node of this.nodes.values()) {
      if (this.inFlight(node.id) < node.capacity) {
        this.assignments.set(ticketId, node.id)
        return { ...node }
      }
    }
    return undefined
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
}
